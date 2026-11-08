# 19: Test ticket (hello.py)

**What to build:** A throwaway ticket for checking that an agent runs in a sandbox and reports status. Not part of the product.

**Blocked by:** none

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

Write a Python file called `hello.py` that asks the user for their name, then prints "hello" followed by that name (for example `hello Sam`). If the name is empty, print `hello world`.

- [ ] `hello.py` exists in the repo root
- [ ] Running `echo Sam | python3 hello.py` prints `hello Sam`
- [ ] Running `echo "" | python3 hello.py` prints `hello world`
- [ ] The change is committed on the ticket branch (do not merge)
