// A very small NEAR, for testing Nobody with nothing installed but Node.
//
// It loads the real compiled contract and runs it the way the protocol does: receipts, promise
// chains, data dependencies, attached deposits, storage staking, prepaid gas, refunds when a
// receipt fails, and access keys with their permissions and allowances. It is a simulation. It
// does not meter wasm execution, so gas burned inside a call is an assumed figure
// (BURN_PER_CALL) and only the gas a contract attaches is real.
import { createHash } from 'node:crypto';
import { nacl } from './open.mjs';
import { decodeSignedTransaction, publicKeyBytes as publicKeyBytesOf, publicKeyText } from './tx.mjs';

export const TGAS = 1_000_000_000_000n;
const YOCTO_PER_BYTE = 10_000_000_000_000_000_000n;
const BURN_PER_CALL = 6n * TGAS;
// The real USDC call burned about 4 Tgas: 278.2 attached, less 258.7 and 15.5 passed on.
const NATIVE_BURN = 3n * TGAS;
const BLOCK_NS = 600_000_000n;
// Measured on testnet: a signer's balance, and a function-call key's allowance, must cover the
// attached gas at about 0.001 NEAR per Tgas while a transaction runs. Most of it comes back.
const RESERVE_PER_GAS = 1_000_000_000n;
// What a signed transaction is assumed to burn in all, about 0.003 NEAR.
const SIGNED_TX_BURN = 3_000_000_000_000_000_000_000n;

export const tgas = (n) => (BigInt(Math.round(n * 10)) * TGAS) / 10n;

/** Decimal NEAR to yocto, without going through floats. */
export function near(amount) {
  const [whole, fraction = ''] = String(amount).split('.');
  return BigInt(whole + fraction.padEnd(24, '0').slice(0, 24));
}

class Panic extends Error {}

const text = new TextDecoder();
const bytesOf = (value) => new TextEncoder().encode(value);
const hex = (bytes) => Buffer.from(bytes).toString('hex');

export class Chain {
  constructor({ startMs = Date.UTC(2026, 10, 10, 9, 0, 0) } = {}) {
    this.nowNs = BigInt(startMs) * 1_000_000n;
    this.height = 100_000_000n;
    this.accounts = new Map();
    this.ready = [];
    this.waiting = [];
    this.data = new Map();
    this.deferred = new Map();
    this.nextId = 1;
    this.trail = [];
  }

  // ---- Accounts ----

  addAccount(id, { balance = 0n, wasm = null, native = null } = {}) {
    const account = { id, balance, storage: new Map(), native, module: null, codeBytes: 0, keys: new Map() };
    if (wasm) {
      account.module = new WebAssembly.Module(wasm);
      account.codeBytes = wasm.length;
    }
    this.accounts.set(id, account);
    return account;
  }

  balance(id) {
    return this.accounts.get(id)?.balance ?? 0n;
  }

  storageBytes(account) {
    let bytes = 100 + account.codeBytes;
    for (const [key, value] of account.storage) bytes += 40 + key.length / 2 + value.length;
    return bytes;
  }

  advance(ms) {
    this.nowNs += BigInt(ms) * 1_000_000n;
    this.height += BigInt(Math.ceil(ms / 600));
  }

  // ---- Transactions and views ----

  /** Sends a transaction and runs every receipt it causes, until only deferred work is left. */
  tx({ signer, receiver, method, args = {}, deposit = 0n, gas = tgas(300) }) {
    const mark = this.trail.length;
    const receipt = this.#receipt({
      signer,
      predecessor: signer,
      receiver,
      actions: [{ method, args: bytesOf(JSON.stringify(args)), deposit, gas, weight: 0n }],
    });
    const payer = this.accounts.get(signer);
    if (payer && deposit > 0n) {
      if (payer.balance < deposit) throw new Error(`${signer} cannot afford ${deposit}`);
      payer.balance -= deposit;
    }
    this.#enqueue(receipt);
    this.run();
    return { receipts: this.trail.slice(mark), first: this.trail[mark] };
  }

  /** The keys on an account, as a node lists them. */
  keysOf(id) {
    return this.accounts.get(id)?.keys ?? new Map();
  }

  /** Gives an account a key, the way creating it with a key would. */
  addKey(id, publicKey, permission = { full: true }) {
    this.accounts.get(id).keys.set(publicKey, { nonce: 0n, ...permission });
  }

  /**
   * A transaction signed with one of the signer's access keys, checked the way a node checks
   * it before anything runs: the key must exist, the nonce must rise, and a function-call key
   * must name this receiver and method, attach no deposit, and have allowance for the gas.
   * The signer pays for the gas: it is reserved while the transaction runs, and all but the
   * burn comes back to the balance and to the key's allowance.
   */
  signedTx({ signer, publicKey, nonce, receiver, method, args = {}, argBytes, gas = tgas(300), deposit = 0n }) {
    const account = this.accounts.get(signer);
    if (!account) throw new Error(`InvalidTxError: ${signer} does not exist`);
    const key = account.keys.get(publicKey);
    if (!key) throw new Error('InvalidAccessKeyError: AccessKeyNotFound');
    const next = BigInt(nonce ?? key.nonce + 1n);
    if (next <= key.nonce) throw new Error('InvalidTxError: InvalidNonce');
    if (!key.full) {
      if (receiver !== key.receiver) throw new Error('InvalidAccessKeyError: ReceiverMismatch');
      if (key.methods.length && !key.methods.includes(method)) throw new Error('InvalidAccessKeyError: MethodNameMismatch');
      if (deposit > 0n) throw new Error('InvalidAccessKeyError: DepositWithFunctionCall');
    }
    const reserved = gas * RESERVE_PER_GAS;
    if (!key.full && key.allowance !== null && key.allowance < reserved) {
      throw new Error('InvalidAccessKeyError: NotEnoughAllowance');
    }
    if (account.balance < reserved + deposit) throw new Error('InvalidTxError: NotEnoughBalance');
    key.nonce = next;
    account.balance -= reserved + deposit;
    if (!key.full && key.allowance !== null) key.allowance -= reserved;

    const mark = this.trail.length;
    const receipt = this.#receipt({
      signer,
      signerPk: publicKey,
      predecessor: signer,
      receiver,
      actions: [{ method, args: argBytes ?? bytesOf(JSON.stringify(args)), deposit, gas, weight: 0n }],
    });
    this.#enqueue(receipt);
    this.run();
    const back = reserved - SIGNED_TX_BURN;
    account.balance += back;
    if (!key.full && key.allowance !== null) key.allowance += back;
    return { receipts: this.trail.slice(mark), first: this.trail[mark] };
  }

  /** Takes a signed transaction in its wire format, checks its signature, and runs it. */
  submit(base64) {
    const tx = decodeSignedTransaction(new Uint8Array(Buffer.from(base64, 'base64')));
    if (!nacl().sign.detached.verify(new Uint8Array(tx.hash), tx.signature, tx.publicKey)) {
      throw new Error('InvalidTxError: InvalidSignature');
    }
    return this.signedTx({
      signer: tx.signer,
      publicKey: publicKeyText(tx.publicKey),
      nonce: tx.nonce,
      receiver: tx.receiver,
      method: tx.method,
      argBytes: tx.args,
      gas: tx.gas,
      deposit: tx.deposit,
    });
  }

  /** Reads a view method. State cannot change, the same as on the real chain. */
  view(id, method, args = {}) {
    const account = this.accounts.get(id);
    const action = { method, args: bytesOf(JSON.stringify(args)), deposit: 0n, gas: tgas(300), weight: 0n };
    const receipt = { id: 0, signer: id, predecessor: id, receiver: id, actions: [action], inputs: [], outputs: [] };
    const result = this.#runWasm(account, receipt, action, true);
    return result.value.length ? JSON.parse(text.decode(result.value)) : null;
  }

  run() {
    while (this.ready.length) this.#execute(this.ready.shift());
  }

  /** Finishes deferred work, the way OutLayer resumes a yielded promise. */
  resume(id, value) {
    const deferred = this.deferred.get(id);
    if (!deferred) throw new Error(`nothing is waiting on ${id}`);
    this.deferred.delete(id);
    for (const output of deferred.outputs) this.#setData(output, { ok: true, value });
    this.run();
  }

  // ---- Receipts ----

  #receipt(fields) {
    return { id: this.nextId++, inputs: [], outputs: [], parent: null, ...fields };
  }

  #enqueue(receipt) {
    if (receipt.inputs.every((id) => this.data.has(id))) this.ready.push(receipt);
    else this.waiting.push(receipt);
  }

  #setData(id, record) {
    this.data.set(id, record);
    const still = [];
    for (const receipt of this.waiting) {
      if (receipt.inputs.every((input) => this.data.has(input))) this.ready.push(receipt);
      else still.push(receipt);
    }
    this.waiting = still;
  }

  #finish(receipt, record) {
    for (const output of receipt.outputs) this.#setData(output, record);
  }

  #execute(receipt) {
    this.nowNs += BLOCK_NS;
    this.height += 1n;
    const account = this.accounts.get(receipt.receiver);
    const action = receipt.actions[0];
    const entry = {
      id: receipt.id,
      parent: receipt.parent,
      predecessor: receipt.predecessor,
      receiver: receipt.receiver,
      method: action.method ?? (action.addKey ? 'add_key' : action.deleteKey ? 'delete_key' : 'transfer'),
      gas: action.gas ?? 0n,
      deposit: action.deposit ?? 0n,
      ok: true,
      error: null,
      logs: [],
    };
    this.trail.push(entry);

    const fail = (message) => {
      entry.ok = false;
      entry.error = message;
      if (entry.deposit > 0n) this.#credit(receipt.predecessor, entry.deposit);
      this.#finish(receipt, { ok: false });
    };

    if (!account) return fail(`${receipt.receiver} does not exist`);
    if (action.addKey || action.deleteKey) {
      // Only an account can change its own keys.
      if (receipt.predecessor !== receipt.receiver) return fail('ActorNoPermission');
      const { publicKey } = action.addKey ?? action.deleteKey;
      if (action.addKey) {
        if (account.keys.has(publicKey)) return fail('AddKeyAlreadyExists');
        const { allowance, receiver, methods } = action.addKey;
        account.keys.set(publicKey, { full: false, allowance, receiver, methods, nonce: this.height * 1_000_000n });
      } else {
        if (!account.keys.delete(publicKey)) return fail('DeleteKeyDoesNotExist');
      }
      return this.#finish(receipt, { ok: true, value: new Uint8Array() });
    }
    if (entry.deposit > 0n) account.balance += entry.deposit;
    if (action.transfer) return this.#finish(receipt, { ok: true, value: new Uint8Array() });

    const undoBalance = account.balance;
    const undoStorage = new Map(account.storage);
    const undo = () => {
      account.balance = undoBalance - entry.deposit;
      account.storage = undoStorage;
    };

    let result;
    try {
      result = account.native
        ? this.#runNative(account, receipt, action)
        : this.#runWasm(account, receipt, action, false);
      this.#commit(account, receipt, result, entry);
    } catch (error) {
      if (result) entry.logs.push(...result.logs);
      undo();
      return fail(error instanceof Panic ? error.message : `wasm trapped: ${error.message}`);
    }
    entry.logs.push(...result.logs);

    if (result.deferred) {
      this.deferred.set(result.deferred, { outputs: receipt.outputs });
    } else if (result.returned === null) {
      this.#finish(receipt, { ok: true, value: result.value });
    }
    for (const fresh of result.fresh) this.#enqueue(fresh);
  }

  #credit(id, amount) {
    const account = this.accounts.get(id);
    if (account) account.balance += amount;
  }

  /** Turns the promises a call made into receipts, and applies what they cost. */
  #commit(account, parent, result, entry) {
    let spent = 0n;
    for (const draft of result.drafts) for (const action of draft.actions) spent += action.deposit ?? 0n;
    if (account.balance < spent) throw new Panic(`${account.id} cannot cover ${spent} yocto of deposits`);
    account.balance -= spent;
    if (!account.native) {
      const needed = BigInt(this.storageBytes(account)) * YOCTO_PER_BYTE;
      if (account.balance < needed) throw new Panic(`${account.id} lacks balance for its storage`);
    }

    result.fresh = [];
    const outputOf = new Map();
    for (let i = 0; i < result.drafts.length; i += 1) outputOf.set(i, `d${this.nextId++}`);
    for (let i = 0; i < result.drafts.length; i += 1) {
      const draft = result.drafts[i];
      const outputs = [];
      const needed = result.drafts.some((other) => other.after.includes(i));
      if (needed) outputs.push(outputOf.get(i));
      if (result.returned === i) outputs.push(...parent.outputs);
      result.fresh.push(
        this.#receipt({
          signer: parent.signer,
          signerPk: parent.signerPk,
          predecessor: account.id,
          receiver: draft.receiver,
          actions: draft.actions,
          inputs: draft.after.map((index) => outputOf.get(index)),
          outputs,
          parent: entry.id,
        }),
      );
    }
  }

  #results(receipt) {
    return receipt.inputs.map((id) => this.data.get(id));
  }

  // ---- Contracts written in JavaScript, for the services around Nobody ----

  #runNative(account, receipt, action) {
    const result = { value: new Uint8Array(), logs: [], drafts: [], returned: null, deferred: null };
    const chain = this;
    let budget = action.gas - NATIVE_BURN;
    const spend = (gas) => {
      if (gas > budget) throw new Panic(`${account.id}: exceeded the prepaid gas`);
      budget -= gas;
    };
    const context = {
      current: account.id,
      predecessor: receipt.predecessor,
      signer: receipt.signer,
      deposit: action.deposit,
      gas: action.gas,
      args: JSON.parse(text.decode(action.args) || '{}'),
      results: this.#results(receipt),
      account,
      log: (line) => result.logs.push(line),
      panic: (message) => {
        throw new Panic(message);
      },
      call(receiver, method, args, { deposit = 0n, gas }) {
        spend(gas);
        result.drafts.push({ receiver, after: [], actions: [{ method, args: bytesOf(JSON.stringify(args)), deposit, gas, weight: 0n }] });
        return result.drafts.length - 1;
      },
      then(previous, receiver, method, args, { deposit = 0n, gas }) {
        const index = context.call(receiver, method, args, { deposit, gas });
        result.drafts[index].after.push(previous);
        return index;
      },
      transfer(receiver, amount) {
        result.drafts.push({ receiver, after: [], actions: [{ transfer: true, deposit: amount }] });
      },
      returnPromise(index) {
        result.returned = index;
      },
      /** Leaves this receipt unfinished until `chain.resume`, like a yielded promise. */
      defer() {
        result.deferred = `y${chain.nextId++}`;
        return result.deferred;
      },
    };
    const value = account.native[action.method]?.(context);
    if (!account.native[action.method]) throw new Panic(`${account.id} has no method ${action.method}`);
    if (value !== undefined) result.value = bytesOf(JSON.stringify(value));
    return result;
  }

  // ---- Running real contract wasm ----

  #runWasm(account, receipt, action, viewOnly) {
    if (!account?.module) throw new Panic(`${receipt.receiver} has no contract`);
    const result = { value: new Uint8Array(), logs: [], drafts: [], returned: null, deferred: null };
    const registers = new Map();
    const inputs = this.#results(receipt);
    let budget = action.gas - BURN_PER_CALL;
    if (budget < 0n) throw new Panic('exceeded the prepaid gas');
    let memory;

    const view = () => new Uint8Array(memory.buffer);
    const read = (length, pointer) => view().slice(Number(pointer), Number(pointer + length));
    const readText = (length, pointer) => text.decode(read(length, pointer));
    const u128At = (pointer) => {
      const bytes = read(16n, pointer);
      let value = 0n;
      for (let i = 15; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
      return value;
    };
    const writeU128 = (pointer, value) => {
      const target = view();
      let rest = value;
      for (let i = 0; i < 16; i += 1) {
        target[Number(pointer) + i] = Number(rest & 0xffn);
        rest >>= 8n;
      }
    };
    const setRegister = (id, bytes) => registers.set(BigInt.asUintN(64, id), bytes);
    const keyOf = (length, pointer) => hex(read(length, pointer));
    const keyText = (length, pointer) => {
      const bytes = read(length, pointer);
      if (bytes[0] !== 0 || bytes.length !== 33) throw new Panic('only ed25519 keys are simulated');
      return publicKeyText(bytes.subarray(1));
    };
    const spend = (gas) => {
      if (gas > budget) throw new Panic('exceeded the prepaid gas');
      budget -= gas;
    };
    const mutating = () => {
      if (viewOnly) throw new Panic('state cannot change in a view call');
    };
    const addCall = (index, method, args, deposit, gas, weight) => {
      spend(gas);
      result.drafts[Number(index)].actions.push({ method, args, deposit, gas, weight });
    };
    const hostError = (name) => () => {
      throw new Panic(`the simulator does not provide ${name}`);
    };

    const host = {
      // Registers
      read_register(id, pointer) {
        const bytes = registers.get(BigInt.asUintN(64, id));
        if (!bytes) throw new Panic('read of an empty register');
        view().set(bytes, Number(pointer));
      },
      register_len(id) {
        const bytes = registers.get(BigInt.asUintN(64, id));
        return bytes ? BigInt(bytes.length) : -1n;
      },
      write_register: (id, length, pointer) => setRegister(id, read(length, pointer)),
      // Context
      current_account_id: (id) => setRegister(id, bytesOf(account.id)),
      signer_account_id: (id) => setRegister(id, bytesOf(receipt.signer)),
      predecessor_account_id: (id) => setRegister(id, bytesOf(receipt.predecessor)),
      input: (id) => setRegister(id, action.args),
      block_index: () => this.height,
      block_timestamp: () => this.nowNs,
      epoch_height: () => this.height / 43200n,
      storage_usage: () => BigInt(this.storageBytes(account)),
      account_balance: (pointer) => writeU128(pointer, account.balance),
      account_locked_balance: (pointer) => writeU128(pointer, 0n),
      attached_deposit: (pointer) => writeU128(pointer, action.deposit),
      prepaid_gas: () => action.gas,
      used_gas: () => action.gas - budget,
      random_seed: (id) => setRegister(id, new Uint8Array(32).fill(7)),
      sha256: (length, pointer, id) => setRegister(id, createHash('sha256').update(read(length, pointer)).digest()),
      // Output
      value_return: (length, pointer) => {
        result.value = read(length, pointer);
      },
      panic: () => {
        throw new Panic('explicit panic');
      },
      panic_utf8: (length, pointer) => {
        throw new Panic(readText(length, pointer));
      },
      log_utf8: (length, pointer) => result.logs.push(readText(length, pointer)),
      abort: () => {
        throw new Panic('abort');
      },
      // Promises
      promise_batch_create(accountLength, accountPointer) {
        mutating();
        result.drafts.push({ receiver: readText(accountLength, accountPointer), after: [], actions: [] });
        return BigInt(result.drafts.length - 1);
      },
      promise_batch_then(previous, accountLength, accountPointer) {
        mutating();
        result.drafts.push({ receiver: readText(accountLength, accountPointer), after: [Number(previous)], actions: [] });
        return BigInt(result.drafts.length - 1);
      },
      promise_batch_action_function_call(index, nameLength, namePointer, argsLength, argsPointer, amountPointer, gas) {
        addCall(index, readText(nameLength, namePointer), read(argsLength, argsPointer), u128At(amountPointer), gas, 0n);
      },
      promise_batch_action_function_call_weight(index, nameLength, namePointer, argsLength, argsPointer, amountPointer, gas, weight) {
        addCall(index, readText(nameLength, namePointer), read(argsLength, argsPointer), u128At(amountPointer), gas, BigInt.asUintN(64, weight));
      },
      promise_batch_action_transfer(index, amountPointer) {
        result.drafts[Number(index)].actions.push({ transfer: true, deposit: u128At(amountPointer) });
      },
      // A public key reaches the host in borsh: a curve byte, then the key.
      promise_batch_action_add_key_with_function_call(index, keyLength, keyPointer, nonce, allowancePointer, receiverLength, receiverPointer, namesLength, namesPointer) {
        void nonce;
        const allowance = u128At(allowancePointer);
        const names = readText(namesLength, namesPointer);
        result.drafts[Number(index)].actions.push({
          addKey: {
            publicKey: keyText(keyLength, keyPointer),
            allowance: allowance === 0n ? null : allowance,
            receiver: readText(receiverLength, receiverPointer),
            methods: names ? names.split(',') : [],
          },
        });
      },
      promise_batch_action_delete_key(index, keyLength, keyPointer) {
        result.drafts[Number(index)].actions.push({ deleteKey: { publicKey: keyText(keyLength, keyPointer) } });
      },
      signer_account_pk(id) {
        if (!receipt.signerPk) throw new Panic('the simulator has no signer key for this receipt');
        setRegister(id, Uint8Array.from([0, ...publicKeyBytesOf(receipt.signerPk)]));
      },
      promise_return: (index) => {
        result.returned = Number(index);
      },
      promise_results_count: () => BigInt(inputs.length),
      promise_result(index, id) {
        const record = inputs[Number(index)];
        if (!record) throw new Panic('no such promise result');
        if (!record.ok) return 2n;
        setRegister(id, record.value);
        return 1n;
      },
      // Storage
      storage_write(keyLength, keyPointer, valueLength, valuePointer, id) {
        mutating();
        const key = keyOf(keyLength, keyPointer);
        const previous = account.storage.get(key);
        account.storage.set(key, read(valueLength, valuePointer));
        if (previous) setRegister(id, previous);
        return previous ? 1n : 0n;
      },
      storage_read(keyLength, keyPointer, id) {
        const value = account.storage.get(keyOf(keyLength, keyPointer));
        if (value) setRegister(id, value);
        return value ? 1n : 0n;
      },
      storage_remove(keyLength, keyPointer, id) {
        mutating();
        const key = keyOf(keyLength, keyPointer);
        const previous = account.storage.get(key);
        account.storage.delete(key);
        if (previous) setRegister(id, previous);
        return previous ? 1n : 0n;
      },
      storage_has_key: (keyLength, keyPointer) => (account.storage.has(keyOf(keyLength, keyPointer)) ? 1n : 0n),
    };

    const imports = {};
    for (const { module, name } of WebAssembly.Module.imports(account.module)) {
      imports[module] ??= {};
      imports[module][name] = host[name] ?? hostError(name);
    }
    const instance = new WebAssembly.Instance(account.module, imports);
    memory = instance.exports.memory;
    const entry = instance.exports[action.method];
    if (!entry) throw new Panic(`${account.id} has no method ${action.method}`);
    entry();

    // Gas left after burning and attaching is shared out by weight, as the protocol does.
    const weighted = result.drafts.flatMap((draft) => draft.actions).filter((item) => (item.weight ?? 0n) > 0n);
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0n);
    if (totalWeight > 0n) for (const item of weighted) item.gas += (budget * item.weight) / totalWeight;
    return result;
  }
}

/** Draws a receipt trail as a tree, for the demo and for debugging. */
export function drawTree(trail) {
  const known = new Set(trail.map((entry) => entry.id));
  const children = new Map();
  for (const entry of trail) {
    const parent = known.has(entry.parent) ? entry.parent : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entry);
  }
  const lines = [];
  const walk = (entry, depth) => {
    const gas = entry.gas ? `${(Number(entry.gas / 100_000_000_000n) / 10).toFixed(1)} Tgas` : '';
    const mark = entry.ok ? '' : `  FAILED: ${entry.error}`;
    lines.push(`${'  '.repeat(depth)}${entry.predecessor} -> ${entry.receiver} :: ${entry.method}  ${gas}${mark}`);
    for (const child of children.get(entry.id) ?? []) walk(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) walk(root, 0);
  return lines.join('\n');
}
