---
title: Upserts in SQLite
author: Grace Hopper
date: 2026-10-05
tags: sqlite3, DB
---

An upsert writes a row once per key: `INSERT ... ON CONFLICT (slug) DO UPDATE`. Pipo's sqlite output does it for you
with `mode: upsert` and `key: slug`, so editing a post never duplicates it.

```sql
SELECT slug, title, tags FROM posts ORDER BY published_at DESC;
```
