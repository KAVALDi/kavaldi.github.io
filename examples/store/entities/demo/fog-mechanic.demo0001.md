---
id: mech-demo0001
type: mechanic
project: demo
title: Туман над маяком
slug: fog
summary: Тестовая механика. Туман сгущается ночью и снижает дальность света фонаря.
visibility: public
states:
  design: accepted
  implementation: pr
  verification: partial
  docs: published
roadmap:
  lane: now
  order: 1
links:
  - rel: relates
    to: idea-demo0002
code_refs:
  - repo: example/lighthouse
    kind: pr
    ref: "7"
    title: Туман и дальность света
    state: merged
    merged_at: 2026-11-05T10:00:00Z
  - repo: example/private-tools
    kind: commit
    ref: abc1234
    title: Внутренний инструмент балансировки тумана
docs_reviewed: 2026-11-01
provenance:
  - kind: decision
    confidence: confirmed
    date: 2026-10-20
    note: Тестовые данные.
created: 2026-10-20
updated: 2026-11-01
revision: 1
---

## Суть

Ночью туман снижает дальность света фонаря вдвое. См. также [[idea-demo0002|идею про сирену]].

## Открытые вопросы

_не заполнено_

## Материал источника

Черновая переписка про туман, которую нельзя публиковать ни при каких условиях.

%% Приватный комментарий: баланс тумана ещё будет меняться после плейтеста. %%
