# Credits Implementation

## Original Notes

We require some unit denomination or some capacity for the contracts which are exchanged across services, shared by sequences in user-to-user models, to expose the capability to purchase contracts of use across capability providers. So, let's say one service or system can sell API keys, and then another system can use the API keys according to the terms of the contract that the API key was purchased under. The monetary range of value between the two systems can be done, and some type of crediting system that we maintain, calculate, and ensure is balanced through looking at the transaction logs across sequences on the system. Maybe the contracts of use are advertised through communities and distributed through communities, but there needs to be some type of module in the system that uses this framework to actually perform cost-per-use API consumption and/or contract purchasing.

---

Credits are both an internal accounting layer AND an inter-system commerce layer. Internally: every capability invocation has a cost, budgets gate invocations, and usage is tracked. Externally: capability providers sell access via contracts, purchasers buy API keys with terms, and the system balances transactions across sequences by inspecting logs.

The user's original notes describe a marketplace where capabilities are bought and sold between systems. A provider publishes a contract ("you can call my API under these terms for this price"). A consumer purchases the contract ("I bought 10,000 calls at $0.01 each"). The crediting system ensures both sides are balanced — the provider's logs show invocations consumed, the consumer's logs show credits spent, and the system can verify consistency.

## Credit Account (Internal)

Every sequence that consumes paid capabilities tracks its own balance:

```ft
CreditAccount = {
  balance: number >= 0,
  spent: number >= 0,
  budget: number >= 0,
  currency: string
}

account = CreditAccount
account << { balance: 10.00, spent: 0, budget: 10.00, currency: "USD" }
```

The behavioral identity: `balance = budget - spent`. Atemporal — holds after every transaction. `spent` increases monotonically. `balance` decreases correspondingly.

## Cost Estimation Before Invocation

Capabilities with costs declare computable cost expressions. The system evaluates BEFORE invocation — if estimated cost exceeds remaining balance, the invocation suspends:

```ft
CostModel = {
  estimateCost: (provider: string, inputTokens: number, outputTokens: number) -> { estimatedCost: number >= 0 }
}

tool CostModel.estimateCost
```

The gate is predictive: `estimatedCost + spent <= budget`. If this projected state exceeds the budget, the mount suspends. Same pattern as the policy builder's `getNextValue(observed + delta)`.

## Per-Invocation Cost Recording

After every invocation, actual cost is recorded alongside the estimate:

```ft
CostRecord = {
  capabilityId: string,
  estimatedCost: number >= 0,
  actualCost: number >= 0,
  inputTokens: number >= 0,
  outputTokens: number >= 0,
  provider: string,
  timestamp: number
}

policy credits: { compact: "preserve" }
```

Credit history uses `preserve` compaction — every transaction is permanently auditable. The estimate-vs-actual comparison feeds into the cost model's reliability prior via conjugate Bayesian update.

## Capability Contracts (Inter-System Commerce)

A capability provider publishes a contract — the terms under which their capabilities can be consumed:

```ft
CapabilityContract = {
  providerId: string,
  capabilities: { name: string, inputType: string, outputType: string },
  pricing: { costPerCall: number >= 0, costPerInputToken: number >= 0, costPerOutputToken: number >= 0 },
  limits: { maxCalls: number >= 0, maxTokens: number >= 0, expiresAt: number },
  apiKey: string
}
```

A consumer purchases the contract. Purchasing means: the contract's terms are mounted onto the consumer's sequence, the API key enables invocations, and each invocation deducts from the purchased allocation:

```ft
purchased = CapabilityContract
purchased << { providerId: "acme-llm", apiKey: "sk-abc123" }
purchased << { pricing: { costPerCall: 0.01, costPerInputToken: 0, costPerOutputToken: 0.00001 } }
purchased << { limits: { maxCalls: 10000, maxTokens: 1000000, expiresAt: 1735689600000 } }
tool purchased.capabilities
```

The contract's limits become while-clauses — the capabilities are available WHILE the allocation isn't exhausted and the contract hasn't expired.

Behavioral identities (in prose since parser can't express them yet):
- **Contract validity**: capabilities are available while `callsConsumed < maxCalls AND tokensConsumed < maxTokens AND _rt < expiresAt`
- **Per-call deduction**: each invocation increments `callsConsumed` and `tokensConsumed`, decrements the consumer's credit balance by the computed cost
- **Cross-sequence balance**: the provider's transaction log and the consumer's transaction log must be reconcilable — total credits spent by consumer = total credits earned by provider for the same contract

## Transaction Balancing Across Sequences

When two sequences transact (consumer invokes provider's capability), both sequences record the event. The system can verify consistency by comparing transaction logs:

```ft
Transaction = {
  contractId: string,
  consumerId: string,
  providerId: string,
  capabilityInvoked: string,
  costCharged: number >= 0,
  timestamp: number
}
```

The balancing invariant: for any contract, the sum of `costCharged` across all consumer transactions equals the sum of `costEarned` across all provider transactions. This is verifiable from the append-only logs without trust — both sides record independently, and the system can audit.

## Community-Distributed Contracts

Contracts of use can be advertised and distributed through communities. A provider publishes available contracts. Community members can purchase and use them:

```ft
ContractListing = {
  contractId: string,
  provider: string,
  description: string,
  pricing: { costPerCall: number >= 0 },
  available: boolean
}
```

The listing is a typed block mounted into a community sequence. Interested consumers narrow it with a purchase action — providing payment credentials and receiving the API key.

## Budget Tiers and Rate Limits

Budgets can be tiered — per-session, per-day, per-provider, per-capability:

```ft
BudgetPolicy = {
  sessionBudget: number >= 0,
  dailyBudget: number >= 0
}
```

Rate limits use the same gating mechanism:

```ft
RateLimit = {
  requestsPerMinute: number >= 0,
  tokensPerMinute: number >= 0,
  windowStart: number,
  windowCount: number >= 0
}
```

When `windowCount >= requestsPerMinute`, invocations suspend until the window resets.

## Provider Cost Profiles

When multiple providers can satisfy a gap, the credit system participates in selection:

```ft
claude = { providerId: "claude", inputCostPerMillion: 3.0, outputCostPerMillion: 15.0, tokenLimit: 200000 }
local = { providerId: "local-llama", inputCostPerMillion: 0, outputCostPerMillion: 0, tokenLimit: 32000 }
```

Selection: estimate cost per provider, filter by `estimatedCost <= balance`, rank by cost within quality/speed constraints.

## Integration with Environment

Credits are part of the environment manifest. Persisted via snapshot. History uses `preserve` compaction:

```ft
env.credits = CreditAccount
env.credits << { balance: 10.00, spent: 0, budget: 10.00, currency: "USD" }
tool env.credits.estimateCost
```

## What This Validates

| Requirement | Expressed by |
|-------------|-------------|
| Credit balance tracked | `CreditAccount` type with balance/spent/budget |
| Cost estimated before invocation | `CostModel.estimateCost` + predictive gate |
| Invocation suspended when over budget | `estimatedCost + spent <= budget` predicate |
| Actual cost recorded | `CostRecord` appended to history |
| Estimate accuracy feeds back | Prior update from estimate-vs-actual |
| Provider selection respects budget | Search filters by cost <= balance |
| Credit history never compacted | `policy credits: { compact: "preserve" }` |
| Credits survive across sessions | Part of environment snapshot |
| Capability contracts purchasable | `CapabilityContract` type with pricing/limits/apiKey |
| Contract limits gate invocations | While-clause on callsConsumed/tokensConsumed/expiresAt |
| Cross-sequence transaction balancing | Transaction logs auditable from both sides |
| Community-distributed contracts | `ContractListing` in community sequences |
| Rate limiting | `RateLimit` with windowed counters |
