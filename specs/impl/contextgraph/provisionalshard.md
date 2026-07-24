# Provisional Shard

## Original Notes

I think this is supposed to be when we boot up or replicate, let's say, some of the core context graph functions at a sub-partition and just replicate it. Any data that we had within that range, let's say that our context, we have a node in our context graph operating on primary key elements A through Z in partition Andrew's metric history, employee activities, or whatever. That chart, we spun up a new instance of the organization process model to operate solely at that shard. That shard is getting a lot of requests; it should be able to, on an update of its page, spawn the request for, or call a function that can create an end with an image with its own image at a new, the next timestamp. Or at some future point in time that exists on some server environment that is created. Right after it gets created, it gets the request to claim certain work, because we can know exactly what that shard is going to have in it with its policies, its snapshot, and all that s***, and its initial data, which we're going to load onto it. The shard should be able to get set up and start working right away. It would then send a message back to the parent saying, "I want to claim this lock now. I'm going to start taking requests for this sub-partition." At which point the parent can start re-indexing it, reset sending its traffic. Once all of its tasks are done for the data that it has remaining on that shard, it can downscale. I don't know why I use the word provisional here; maybe you could think of another use case, but that was the idea for this.

## Overview

A parent process owns a data partition. When a sub-range of that partition is under heavy load, the parent spawns a child shard to take ownership. The shard receives the parent's schemas, policies, and a data snapshot for the sub-range, so it can start processing immediately -- zero warm-up.

The lifecycle is: spawn with snapshot, claim lock on sub-partition, receive redirected traffic, operate, drain when load subsides, merge results back to parent, terminate. The critical constraint is that there must never be a gap in ownership -- the parent handles the sub-partition until the shard explicitly claims it, and the shard's work must merge back before termination so nothing is lost.

## The Shard Type

A shard tracks its sub-range, lifecycle phase, and the lock that gates traffic redirection:

```ft
Shard = {
  subRange: string,
  status: "initializing" | "claiming" | "active" | "draining" | "merged",
  lockClaimed: boolean,
  queueDepth: number.integer >= 0
}
```

`subRange` defines the key range this shard is responsible for (e.g., "N-Z"). `status` tracks the lifecycle phase. `lockClaimed` is false until the shard signals readiness. `queueDepth` tracks remaining work during the drain phase.

## Spawn with Snapshot

The parent creates the shard and provides everything it needs to operate -- schemas, policies, and data for the sub-range. The shard starts in `"initializing"` status:

```ft
shard1 = Shard
shard1 << {
  subRange: "N-Z",
  status: "initializing",
  lockClaimed: false,
  queueDepth: 0
}
```

The shard receives the parent's configuration as part of initialization. It does not re-derive schemas or policies from scratch. It receives a complete snapshot and is ready to process requests within one operation cycle.

## Lock Claim and Traffic Redirection

Once initialized, the shard claims its lock. This signals to the parent that the shard is ready to accept traffic:

```ft
shard1 << { status: "claiming", lockClaimed: true }
shard1 << { status: "active" }
```

The parent observes the lock claim and redirects traffic for the sub-range to the shard. Before the claim, the parent continues handling all requests -- no gap in service. After the claim, the parent stops processing the sub-range locally.

Traffic routing is conditioned on the lock: requests for the sub-range go to the shard only while `lockClaimed = true` and `status = "active"`. The parent forwards or rejects sub-range requests once traffic is redirected.

## Drain and Merge

When load subsides, the shard enters draining mode. It completes remaining queued work but rejects new requests:

```ft
shard1 << { status: "draining" }
-- shard processes remaining queueDepth items
-- new requests for sub-range forwarded back to parent
shard1 << { queueDepth: 0 }
```

After draining, the shard's results merge back into the parent's state. The parent's data for the sub-range reflects all work the shard performed:

```ft
shard1 << { status: "merged", lockClaimed: false }
```

After merge, traffic for the sub-range returns to the parent. The shard is eligible for termination. No data is lost.

## Capabilities

The shard lifecycle is managed by the parent. The shard's status and lock are externally observable:

```ft
tool Shard.status
tool Shard.lockClaimed
tool Shard.queueDepth
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Shard gets parent schemas + snapshot | Configuration provided at creation, not re-derived |
| Shard processes requests immediately | Status moves to "active" after claim, zero warm-up |
| Lock claim gates traffic redirection | `lockClaimed: true` before parent redirects |
| Parent handles sub-range before claim | `lockClaimed: false` during initialization |
| Parent stops processing after redirect | Sub-range requests forwarded once shard is active |
| Drain completes remaining work | `status: "draining"`, queueDepth decrements to 0 |
| Merge returns results to parent | `status: "merged"` after results integrated |
| No data lost on termination | Merge happens before shard becomes eligible for termination |
