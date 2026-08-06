---
title: "The Same Failure, Wearing a Different Hat"
date: 2026-08-06
draft: false
tags: ["deployment", "debugging"]
---

I set out to put a small Hugo site behind a subdomain. Straightforward: build the site, push it, point DNS at it. The build took eleven seconds. The deploy took the rest of the afternoon.

## What happened

GitHub Actions built the site fine. The deploy step then sat there:
Current status: deployment_queued
Current status: deployment_queued
Current status: deployment_queued
...
##[error]Timeout reached, aborting!

Ten minutes of polling, then it gave up. I retried. Same thing. The build artifact was correct — I could see the generated files in the branch — but nothing was reaching the CDN.

So I switched deployment methods. Instead of the artifact upload API, I'd push the built output to a `gh-pages` branch and let GitHub serve it from there. Different mechanism, older and more boring, and I had a working instance of it on another site. The workflow ran in eighteen seconds. Progress.

Then the page build failed, and the log said:
Current status: deployment_queued
##[error]Timeout reached, aborting!

## The part worth writing down

The two approaches looked different from where I was standing. One uploads an artifact and calls a deployment API. The other commits files to a branch and lets the platform pick them up. Different configuration, different workflow file, different mental model.

They both call the same deployment backend. The branch-based method just gets there through an extra hop.

I'd changed the part I could see and left the part that was actually broken untouched. Then I spent another twenty minutes confirming that the thing I hadn't fixed was still not fixed.

This is not a new lesson. It's the same one from any system where you have partial visibility: when you switch approaches, check whether you've actually swapped out the failing component or just re-routed to it. The visible layer and the failing layer are often not the same layer. Something that "feels different" from the operator's seat can be identical from the failure's seat.

The tell was there in the log the whole time — the identical error string. I read it as "still broken" rather than "broken in exactly the same place," which are different claims.

## The fix

Cloudflare Workers. Full build and deploy in thirty-three seconds, which is roughly what I'd assumed the whole task would take before I started.

One more snag: I pointed the subdomain at the worker with a proxied CNAME, which produced a 522. Proxying a hostname that already lives inside the same network makes the proxy try to reach it as though it were an external origin. The correct binding is declared in the project config instead:

```toml
[[routes]]
pattern = "lab.example.org"
custom_domain = true
```

Push, wait thirty seconds, done.

## Afterward

Nothing here required cleverness. The site is four markdown files and a theme. Every individual step was documented and simple, and the total time was still several hours, almost all of it spent on a failure that had nothing to do with anything I'd written.

I keep encountering a version of this. The work is easy and the tooling is fine, right up until one layer you don't control stops responding, and you have no way to see into it. You get a status string and a timeout. Everything you try to do about it is a guess about what's happening on the other side of an API you can't inspect.

The reasonable response is probably to notice sooner when you've stopped debugging and started guessing, and to leave earlier when leaving is cheap. Switching platforms cost ten minutes. I'd been at the other thing for three hours.
