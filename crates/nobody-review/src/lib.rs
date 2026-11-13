//! What Nobody sells: a security review of a NEAR smart contract.
//!
//! Static rules from NEAR's audit checklist find candidates in plain code, so a README cannot
//! talk its way past them. The model then judges each candidate and adds what the rules cannot
//! see, and its judgement never moves money. Nothing here touches the network, so all of it runs
//! and tests on any machine.

pub mod audit;
pub mod keeper;
pub mod prompt;
pub mod report;
pub mod seal;
pub mod snapshot;
