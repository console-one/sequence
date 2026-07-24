# FSM

An entity has a lifecycle -- created, paid, shipped, delivered. Transitions between states are conditional: you can only pay a created order, only ship a paid one. Traditional FSM frameworks maintain a separate transition table and engine. That duplicates the constraint system. The right answer: state is a typed value, transitions are writes gated on the current value, and valid actions are the projection of which gates are currently passable. No framework. Just typed state and conditional writes.

Invalid transitions do not reject -- they suspend. The intent is preserved. If a refund flow returns the entity to "created," a previously-suspended "pay" intent could resume. Suspension preserves intent; rejection destroys it.

## The Order Type

An order has a state constrained to the valid lifecycle values, plus data that accumulates with each transition:

```ft
OrderState = "created" | "paid" | "shipped" | "delivered"

Order = {
  state: OrderState,
  paymentRef: string,
  tracking: string,
  deliveredAt: number
}
```

State is always exactly one of the valid values. An entity cannot be in two states simultaneously.

## Transitions as Conditional Writes

Each transition is a write gated on the current state. The "pay" transition only succeeds when state is "created":

```ft
order = Order
order << { state: "created" }

-- pay transition: gated on current state
order << { state: "paid" when order.state = "created" }
order << { paymentRef: "pay-abc" }
```

The `when order.state = "created"` gate enforces the transition graph. If state is not "created," the write suspends rather than rejecting. The suspended intent remains visible in the gap surface.

## The Full Lifecycle

Each transition gates on the previous state and carries its required data:

```ft
-- ship transition: gated on "paid"
order << { state: "shipped" when order.state = "paid" }
order << { tracking: "track-xyz" }

-- deliver transition: gated on "shipped"
order << { state: "delivered" when order.state = "shipped" }
order << { deliveredAt: 1712345678 }
```

After each transition, the previously-valid transition is blocked (gate no longer passable) and the next transition becomes available. The gap surface always reflects the current state's requirements.

## Surfacing Valid Actions

The set of currently valid transitions is the set of gates that match the current state. When state is "created," the gap surface shows "pay" as available with "paymentRef" as a required field. When state is "paid," it shows "ship" with "tracking" required.

This is not a separate query mechanism -- it is the projection of which conditional writes have satisfiable gates. The type already contains the answer.

## Multiple Independent Entities

Each entity has its own state. Transitioning one does not affect others:

```ft
orderA = Order
orderA << { state: "created" }

orderB = Order
orderB << { state: "paid" }

-- transitioning A does not touch B
orderA << { state: "paid" when orderA.state = "created" }
orderA << { paymentRef: "pay-001" }
```

## Capabilities

Transitions are externally triggered. Each transition's required data is a capability:

```ft
cap order.state
cap order.paymentRef
cap order.tracking
cap order.deliveredAt
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Invalid state value fails | `OrderState` union constrains to valid values |
| Pay succeeds from "created" | `when order.state = "created"` gate passes |
| Pay suspends from "paid" | Same gate fails, write suspends (not rejects) |
| Missing data surfaces as gap | `paymentRef` required but unfilled shows in obligations |
| Valid actions reflect current state | Gate passability projection |
| Pay blocked after transition to "paid" | Gate on "created" no longer passable |
| Independent entities | Separate `orderA`, `orderB` instances |
| Atomic transition with data and timestamp | State + paymentRef written together |
