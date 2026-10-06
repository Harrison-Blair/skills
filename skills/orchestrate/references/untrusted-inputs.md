# Untrusted inputs

Cases to cover whenever code takes input it does not control. Link this file from the brief and name which kinds apply; the implementer tests each listed case in its first pass, and the verifier checks coverage against this list before designing probes of its own.

For every kind: no crash, no stack trace, one plain error line, a documented exit code, a bounded time to fail, and nothing signalled, deleted or written that the input did not entitle.

## A file path the code reads

- Missing; empty; not the expected format; valid but with 10000 extra keys.
- Wrong type at the path: directory (empty and non-empty), symbolic link (to a valid file elsewhere, to a missing target, to a directory, to `/dev/zero` or `/dev/urandom`, a chain of links), FIFO, socket.
- Size: one byte under the limit, exactly the limit, one over, and far over (5 MB).
- Permissions: unreadable file; unwritable parent when the code must remove or replace it; a directory the code cannot traverse.
- Timing: replaced between the check and the read; growing while read; another process holding a lock.
- Name the one function that reads it, check the type with `lstat`, open without following links, and read a bounded number of bytes.

## A process id the code signals or probes

- 0, 1, negative, non-integer, numeric string, null, missing, larger than the platform maximum.
- The code's own pid and its parent's pid.
- A live pid that belongs to an unrelated process; a pid that was recorded, died, and was reused.
- Prove with a recorder that replaces the kill call and sends nothing; run under a new session so a stray signal to pid 0 cannot reach the test itself.

## A network peer the code talks to

- Nothing listening; connection refused; accepts and never replies; closes at once.
- Wrong identity: a different service on the port; the right shape of reply with a different id; the right id only after a long delay.
- Broken replies: headers then half a body then the peer dies; socket destroyed mid-body; chunked reply trickling one byte per second; a 10 MB body; not the expected content type.
- Identity that changes between two requests.
- Name the one request function; it must settle exactly once on a complete reply, a request error, a reply cut off before its end, or a total deadline. An idle timeout that each byte resets is not a deadline.

## An environment variable or setting

- Unset; empty; not a number; 0; negative; enormous; with surrounding spaces.
- Accept only what the documentation says and ignore the rest silently or with one line; never pass the raw value to a system call.

## A string from a user, a page or a file

- Empty; only spaces; very long; every kind of quote; `#`, `?`, `%`, `&`, `;`, `+`, a non-ASCII letter, a newline.
- Names that collide with inherited object keys: `__proto__`, `constructor`, `toString`, `hasOwnProperty`, `prototype`.
- Encoded traversal: `..`, `%2e%2e%2f`, an absolute path, a path that resolves outside the allowed folder through a link.
- The wrong shape entirely: null, an array, a number, a nested wrapper, a missing required field, each field of a wrong type, 500 sent in one burst.

## Timing

- Two of the same command at once; a start during a stop; a stop while a blocking command waits; the peer killed while a request is in flight. Ten runs each, and nothing orphaned or left on disk afterwards.
