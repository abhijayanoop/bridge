# 17: Analyst agent

**What to build:** A separate read-only Analyst agent analyses real data. It is off by default, enabled per connection, uses a read-only database role with credentials held on the host, and masks names and identifiers by default.

**Blocked by:** 06, 07, 08

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

- [ ] The Analyst is disabled until a connection is enabled in settings
- [ ] Queries run through a host-side read-only tool for MongoDB and Postgres/Supabase; the sandbox never holds credentials
- [ ] Masking is on by default; each dataset needs approval
- [ ] A guided wizard sets up the read-only role
- [ ] Tested against a seeded sample database, never real data
