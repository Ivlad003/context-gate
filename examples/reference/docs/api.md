# REST API conventions

- Resources are plural nouns: `/users`, `/users/:id`.
- Errors: `{ "code": "USER_NOT_FOUND", "message": "…" }` with the matching HTTP status.
- Pagination: cursor-based, `?cursor=<id>`, response `{ items, nextCursor }`.
