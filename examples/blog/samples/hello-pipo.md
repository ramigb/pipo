---
title: Hello, Pipo
author: Ada Lovelace
date: 2026-10-01
tags: [Meta, howto]
---

This blog is a **Pipo pipeline**. Drop a markdown file in `posts/`, POST JSON to the API, or push a post by hand:
each one is tagged and written to SQLite, and the site is rebuilt from it.

## How it works

1. A `watch` input reads `posts/*.md`.
2. `fn.normalize` gives every post one shape and adds topic tags.
3. A `tap: exec` rebuilds the static site, and the output upserts the row by slug.

> Edit this file and the post updates in place.
