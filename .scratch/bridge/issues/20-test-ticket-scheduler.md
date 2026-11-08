# 20: Test ticket (task scheduler)

**What to build:** A throwaway ticket for checking that an agent runs in a sandbox, reports status, and hands its branch back. Not part of the product.

**Blocked by:** none

**Status:** ready-for-agent

Parent: .scratch/bridge/spec.md

Write `schedule.py` (Python 3, standard library only). It reads JSON from stdin describing tasks and their dependencies, and prints the earliest schedule as JSON.

Input: `{"tasks": [{"id": "a", "days": 2, "after": []}, ...]}` where `after` lists the ids a task waits for.

Output on success (exit 0): `{"order": [...], "finish": N, "critical": [...]}`
- `order`: a valid order to do the tasks in. Break ties alphabetically by id.
- `finish`: the total days until every task is done, with unlimited parallel workers.
- `critical`: the ids on the longest chain, in order. If two chains tie, pick the one that is alphabetically first.

Errors, each with a one-line message on stderr and nothing on stdout:
- a dependency cycle: exit 1, the message starts with `cycle:` and names the tasks in the cycle
- an `after` entry that is not a task id: exit 2, the message starts with `unknown task:`
- duplicate ids or invalid JSON: exit 3

Also write `test_schedule.py` using `unittest` that covers every case above, and keep both files in the repo root.

- [ ] For `{"tasks":[{"id":"a","days":2,"after":[]},{"id":"b","days":3,"after":["a"]},{"id":"c","days":1,"after":["a"]},{"id":"d","days":2,"after":["b","c"]}]}` the output is `{"order": ["a","b","c","d"], "finish": 7, "critical": ["a","b","d"]}` (whitespace may differ)
- [ ] A task with no dependencies and an empty task list both work (empty list: `finish` is 0, `order` and `critical` are empty)
- [ ] Cycles, unknown tasks, duplicate ids and bad JSON give the exit codes above
- [ ] `python3 -m unittest test_schedule` passes
- [ ] The work is committed on the ticket branch (do not merge)
