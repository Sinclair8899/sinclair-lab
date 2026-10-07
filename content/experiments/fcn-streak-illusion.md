---
title: "The Streak Illusion — an FCN knock-in explorer"
date: 2026-08-10T18:00:00+08:00
layout: fcn-explorer
description: "What 26 years of semiconductor prices say about fixed coupon notes: move the knock-in barrier and see how quickly delivery risk, tail loss, and the value of a clean streak change."
summary: "An interactive companion to my working paper 'When Winning Streaks Mislead'. 84 worst-of-3 baskets, monthly starts, 2000–2026 — settle every note, then ask what a clean streak actually predicted."
---

A fixed coupon note (FCN) pays a steady coupon as long as a basket of stocks behaves. The catch is the **knock-in barrier**: if no autocall occurs, at least one stock touches the barrier, and the worst stock finishes below strike, the note can settle into shares rather than cash — usually at a loss. Sellers of these notes often rely on one sales exhibit: *"this structure has not delivered shares in years."*

My paper [*When Winning Streaks Mislead*](https://sinclairhuang.org/publications/) asks what that clean streak is actually worth as statistical evidence. This page turns the paper's historical engine into an interactive exhibit: nine US-listed semiconductor names, every worst-of-3 basket (84 of them), notes started monthly from 2000 to 2026, and reinvestment over the selected horizon. The 60% barrier reproduces the working paper's reported configuration; other barriers, strikes, tenors and autocall starts re-run the same engine so readers can see how delivery risk and tail loss move when the terms change.

Two things to watch. First, how fast the delivery rate responds to the barrier — the difference between a 50% and a 70% barrier is not a detail, it is the whole product. Second, the last chart: at the paper's 60% barrier, after about four clean quarters, more clean quarters add little information about the probability of a delivery in the *next year* — from there on, the bars' uncertainty bands all overlap one another. The drop before that shows up in the point estimates, but its size is uncertain. History's calm stretches told you which regime you were in — they did not tell you it would last.
