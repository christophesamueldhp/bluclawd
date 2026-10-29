# Redacting denied names from find and ls output

The permissions extension does not remove the names of denied files from what the
`find` and `ls` tools list. A `Read(secret/**)` rule blocks reading `secret/key.pem`,
and also blocks `ls secret`. But `ls .` or `find` with the pattern `*.pem` from the
project root still show that `secret/key.pem` exists.

## Why this is out of scope

Deny rules guard what a call names, not what it reveals. The one exception, dropping
grep lines that came from denied files, exists because grep output carries file
*contents*, which a `Read` rule is meant to keep out. A name is not content: the
file's contents stay blocked, because `read` of it is denied.

Hiding names from the `find` and `ls` tools would not hide them anyway. The same
listing is one bash command away, and bash names only the parent folder, so no file
rule matches:

```sh
find . -name '*.pem'   # allowed under Read(secret/**); prints ./secret/key.pem
ls -R .                # likewise
git ls-files           # likewise, for tracked files
```

Filtering only the two tools would suggest a guarantee the rules cannot keep. It
would also bring back output parsing per tool (the earlier
`pathListOutputWithoutDenied`, removed with the dead child-policy code) to maintain.

No layer of bluclawd promises to hide a file's name. If the name itself is secret, keep
the file outside the folders the agent works in.

## Prior requests

- #66: "Decide whether the permissions extension redacts denied paths from find and ls"
