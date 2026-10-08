# SQLAlchemy instead of peewee

**Status:** accepted (2026-10-04), sivkit 0.12.

peewee binds a database to model classes globally (`bind_ctx`), so adapters on different threads can query each other's database. The lack of an elegant solution in terms of syntax warranted an inquery into alternatives. SQLAlchemy is the most established python ORM, and it has a lot more integrations. So though it has its flaws - we switch to it.

Formal reason: cloud integrations may require Postgres support.
Accepted drawbacks: memory overhead (peewee ~0.3 MB vs sqlalchemy ~15MB)
