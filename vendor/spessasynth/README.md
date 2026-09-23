# spessasynth (vendored)

- spessasynth_lib 4.3.14 / spessasynth_core 4.3.22 (Apache-2.0, see LICENSE)
- `spessasynth_lib.min.js`: spessasynth_lib + spessasynth_core bundled into one ES module (only `WorkletSynthesizer` is exported)
- `spessasynth_processor.min.js`: AudioWorklet processor, copied as-is from `spessasynth_lib/dist/`

Regenerate (outside this repo):

```sh
npm i spessasynth_lib esbuild
echo 'export { WorkletSynthesizer } from "spessasynth_lib";' > entry.js
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=eof --outfile=spessasynth_lib.min.js
cp node_modules/spessasynth_lib/dist/spessasynth_processor.min.js .
```
