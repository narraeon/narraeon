# Historical world-revision session fixture

`session.json` was written by commit `ae20e1f` (the parent of issue #146) using the unmodified `WorldRevisionSession` and `FileNativeWorldRevisionStore`. It was captured after the first request in the existing `AI 对话写入同一工作树，应用后继续原对话会收到新 epoch 并强制重新读取` test; the only test instrumentation copied the saved file bytes to this fixture. Its random identifiers are part of the original saved bytes.
