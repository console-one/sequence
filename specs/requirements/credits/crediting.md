# Credits Implementation

## Original Notes

We require some unit denomination or some capacity for the contracts which are exchanged across services, shared by sequences in user-to-user models, to expose the capability to purchase contracts of use across capability providers. So, let's say one service or system can sell API keys, and then another system can use the API keys according to the terms of the contract that the API key was purchased under. The monetary range of value between the two systems can be done, and some type of crediting system that we maintain, calculate, and ensure is balanced through looking at the transaction logs across sequences on the system. Maybe the contracts of use are advertised through communities and distributed through communities, but there needs to be some type of module in the system that uses this framework to actually perform cost-per-use API consumption and/or contract purchasing.

---

## Problem Context

- **Actor(s)**: Capability providers (who sell API access), capability consumers (who purchase and use API access), the crediting system (which tracks balances and verifies consistency), community marketplaces (where contracts are advertised).
- **Domain**: Metered capability commerce -- internal cost accounting for API usage and inter-system contract-based capability purchasing.
- **Core Tension**: The system must gate expensive invocations on available budget (preventing overspend) while supporting a decentralized marketplace where providers and consumers transact independently and neither side is trusted to self-report honestly.

## Requirements

**R1**: The system SHALL maintain a credit balance for each entity that consumes paid capabilities.
- *Rationale*: Without per-entity balance tracking, there is no way to enforce budgets or detect overspend.
- *Verifiable by*: After a series of capability invocations, the credit balance reflects the initial budget minus the sum of all recorded costs.

**R2**: The system SHALL estimate the cost of a capability invocation BEFORE executing it and SHALL reject the invocation if the estimated cost would exceed the remaining balance.
- *Rationale*: Post-hoc cost accounting cannot prevent overspend. The gate must be predictive.
- *Verifiable by*: An invocation whose estimated cost exceeds the remaining balance is not executed; the caller receives a rejection signal.

**R3**: The system SHALL record both the estimated cost and the actual cost of every invocation.
- *Rationale*: Estimate-vs-actual comparison is necessary for improving future estimates and for auditing.
- *Verifiable by*: After an invocation completes, a cost record exists containing both the estimated and actual cost, along with metadata (provider, timestamp, token counts).

**R4**: Transaction history SHALL be permanently retained and never compacted or summarized.
- *Rationale*: Auditing and cross-party reconciliation require access to every individual transaction.
- *Verifiable by*: No transaction record is ever removed from the log, regardless of age or system state.

**R5**: A capability provider SHALL be able to publish a contract specifying pricing, usage limits, and an expiration time.
- *Rationale*: Providers need to define the terms under which their capabilities are consumed.
- *Verifiable by*: A published contract contains per-call cost, per-token cost, maximum call count, maximum token count, and expiration timestamp.

**R6**: A consumer SHALL be able to purchase a contract, receiving an API key that enables invocations under the contract's terms.
- *Rationale*: This is the mechanism by which consumers gain access to provider capabilities.
- *Verifiable by*: After purchasing a contract, the consumer possesses a valid API key and can invoke the provider's capabilities.

**R7**: Capabilities acquired through a contract SHALL be available only while the contract's limits are not exhausted and the contract has not expired.
- *Rationale*: Contracts are finite; exceeding limits or expiration must revoke access.
- *Verifiable by*: After exhausting call or token limits, or after the expiration time passes, further invocations are rejected.

**R8**: Each invocation under a contract SHALL decrement the consumer's credit balance and increment the consumer's usage counters against the contract.
- *Rationale*: Both cost and usage must be tracked per invocation to enforce limits.
- *Verifiable by*: After N invocations, the consumer's call count equals N and the balance has decreased by the sum of per-invocation costs.

**R9**: The system SHALL support cross-party transaction reconciliation: the sum of costs charged to a consumer for a given contract SHALL equal the sum of earnings credited to the provider for the same contract.
- *Rationale*: Both parties record transactions independently. The system must be able to verify consistency without trusting either side.
- *Verifiable by*: For any contract, an audit function computes the sum from consumer logs and the sum from provider logs and confirms they match.

**R10**: Contracts SHOULD be distributable through community marketplaces where providers list available contracts and consumers browse and purchase them.
- *Rationale*: The original notes specifically describe communities as the distribution channel for contracts.
- *Verifiable by*: A provider can publish a contract listing to a community; a community member can view and purchase a listed contract.

**R11**: Budgets SHALL support tiered scoping (per-session, per-day, per-provider, per-capability).
- *Rationale*: Different usage patterns require different budget granularities.
- *Verifiable by*: A session budget can be exhausted independently of a daily budget; a per-provider budget gates only that provider's invocations.

**R12**: The system SHALL enforce rate limits (requests per minute, tokens per minute) and SHALL suspend invocations when limits are reached until the rate window resets.
- *Rationale*: Rate limits protect both the consumer from runaway costs and the provider from abuse.
- *Verifiable by*: After reaching the rate limit, the next invocation is suspended; after the window resets, invocations resume.

**R13**: When multiple providers can satisfy a request, the system SHOULD select among them considering cost relative to remaining balance, quality, and speed.
- *Rationale*: Cost-aware provider selection prevents unnecessary spend when cheaper alternatives exist.
- *Verifiable by*: Given two providers with different costs and sufficient quality, the system selects the cheaper one when budget is constrained.

**R14**: Credit state SHALL persist across sessions.
- *Rationale*: A user's balance and transaction history must survive application restarts.
- *Verifiable by*: After restarting the application, the credit balance and transaction history are unchanged from the prior session.

## Acceptance Criteria

**AC1** [R1]: Given a new consumer entity with an initial budget of $10.00, when querying the credit balance, then balance = $10.00 and spent = $0.00.

**AC2** [R2]: Given a consumer with balance = $0.50 and an invocation with estimated cost = $1.00, when the invocation is attempted, then it is rejected with an insufficient-balance signal.

**AC3** [R3]: Given a completed invocation with estimated cost = $0.01 and actual cost = $0.012, when querying the transaction log, then a record exists containing both values.

**AC4** [R4]: Given a transaction log with 10,000 entries over 90 days, when any compaction or cleanup process runs, then all 10,000 entries remain accessible.

**AC5** [R5, R6]: Given a provider publishes a contract with costPerCall = $0.01 and maxCalls = 10,000, when a consumer purchases it, then the consumer receives an API key and the contract terms are enforced.

**AC6** [R7]: Given a contract with maxCalls = 100 and 100 calls already consumed, when the consumer attempts call 101, then the invocation is rejected.

**AC7** [R7]: Given a contract with expiresAt = T and the current time > T, when the consumer attempts an invocation, then the invocation is rejected.

**AC8** [R9]: Given consumer A has invoked provider B's capabilities 50 times under contract C, when auditing, then the sum of costs in A's log for contract C equals the sum of earnings in B's log for contract C.

**AC9** [R12]: Given a rate limit of 10 requests/minute and 10 requests already made in the current window, when request 11 is attempted, then it is suspended until the window resets.

**AC10** [R14]: Given a consumer with balance = $7.32 and 47 transaction records, when the application restarts and state is reloaded, then balance = $7.32 and all 47 records are present.

## Open Questions

1. How does the cost model improve its estimates over time? The estimate-vs-actual gap should feed back into future estimates, but the specific mechanism (exponential moving average, Bayesian update, etc.) is not specified.
2. What happens when a provider's transaction log and a consumer's transaction log disagree during reconciliation? The detection is specified but the resolution protocol is not.
3. Should rate limit windows be fixed (e.g., clock-aligned minutes) or sliding? The choice affects both fairness and implementation complexity.
