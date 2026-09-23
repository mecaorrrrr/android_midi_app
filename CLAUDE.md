# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code 向けのガイドです。ユーザーとのやり取りは日本語で行う。

## プロジェクト概要

**GamePad MIDI Sequencer** — ゲームパッド（Gamepad API）で操作する、ブラウザ動作の MIDI シーケンサー PWA。
Android の Chrome での利用を主目的とし、PC ブラウザでも動作する。8 トラックのピアノロール、SF2/SFZ サウンドフォント再生、JSON プロジェクト保存、MIDI エクスポートを備える。
操作仕様・ボタン配置・プロジェクト JSON 形式の詳細は `README.md` を参照。

## 実行・デプロイ

- ビルド工程・パッケージマネージャ・テストは**無い**。素の HTML/CSS/ES Modules。
- ローカル確認は静的サーバー経由（ES Modules と Service Worker のため `file://` 不可）: `npx http-server .`
- AudioContext はページの最初のクリックで初期化される（`main.js` の `document.body` click ハンドラ）。
- デプロイ: `main` への push で `.github/workflows/static.yml` がリポジトリ直下をそのまま GitHub Pages に公開する。
- `sw.js` はキャッシュ優先。**JS/CSS を追加・改名したら `ASSETS` を更新し、`CACHE_NAME` のバージョンを上げる**（上げないと古いファイルが配信され続ける）。
- 外部ライブラリを導入する場合は、ビルド不要で読み込める形（ESM の CDN、またはリポジトリ内にベンダリング）にする。オフライン動作させるなら `sw.js` のキャッシュ対象にも含める。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | エントリ。ヘッダー、`#piano-roll` canvas、各モーダル（コントローラー設定・トラック一覧）。モーダル用 CSS がインライン `<style>` にある |
| `style.css` | 基本スタイル。CSS 変数（`--primary-accent` 等）を `:root` に定義 |
| `main.js` | `App` クラス。状態（`songData`）、undo/redo、FILE/ADD メニューの**動的生成**、モーダル、保存/読込、MIDI 書き出し、メインループ |
| `ui.js` | `UIManager`。Canvas 描画（グリッド、ノート、ゴーストノート、ルーラー、鍵盤、カーソル、選択範囲）。色はコード内にハードコード |
| `input.js` | `InputManager`。Gamepad ポーリング、ボタンマッピング（localStorage `gamepad_mapping`）、カーソル移動、ノート配置/編集/選択/コピー、修飾キー操作。キーボード操作もここ |
| `audio.js` | `AudioManager`。SF2/SF3/DLS は spessasynth（AudioWorklet）で再生、SFZ は自前サンプラー、音源未ロード時はサイン波。全発音は `playNoteAt(trackId, pitch, vel, startTime, endTime)`（AudioContext 時刻）経由 |
| `scheduler.js` | `Scheduler`。先読み（lookahead 0.12 秒）で `playNoteAt` に正確な時刻付きでノートを渡す。ループはセグメント（AudioContext 時刻↔拍の対応）を追加して処理 |
| `vendor/spessasynth/` | spessasynth_lib + core を esbuild で 1 ファイルにバンドルしたものと AudioWorklet プロセッサ。再生成手順は同フォルダの README.md |
| `transport.js` | `TransportManager`。テンポマップ・拍子マップ・マーカー、拍→小節変換、拍↔秒変換（`secondsBetween` / `beatAfter`） |
| `midi_encoder.js` | SMF 書き出し |
| `audio.js.old`, `main.js.old`, `sf2parser.old` | 旧バージョンの退避。参照のみで、読み込まれていない |
| `gamepaddisplayer.html`, `padtesterwithclaude.html` | ゲームパッド入力の単体テストページ |
| `implementation_plan.md`, `task.md`, `walkthrough.md` | 初期開発時のメモ（内容は古い） |

## アーキテクチャ上の要点

- `App` が中心で、各マネージャーは `app` 参照を受け取って相互にアクセスする（`this.app.songData` など）。
- 時間の単位は**拍（beat）**。ノートは `{ time, pitch, duration, velocity }`（time/duration は拍）。
- トラック数は 8 固定で、`main.js` / `audio.js` の複数箇所に `8` がハードコードされている。
- **再生**: `App.startPlayback()` / `stopPlayback()` / `togglePlayback()` が入口。`App.loop()`（requestAnimationFrame）は毎フレーム `scheduler.update()` を呼び、`cardinalTime`（プレイヘッド）は `scheduler.currentBeat()` から AudioContext の時刻を基準に求める。ミュート/ソロは予約時点で判定する。
- **発音（SF2）**: トラック N = MIDI チャンネル N。音量/パンは CC7/CC10、音色は Bank Select (CC0/CC32) + Program Change、ドラムは `midiChannels[N].setDrums(true)`（プリセット一覧では bank 128 として扱う）。ADSR・フィルター・モジュレーター等はすべて spessasynth が SF2 仕様どおりに処理する。
- **停止**: spessasynth の予約済みイベントは取り消せないため、`AudioManager.stopAll()` は未来の noteOn と同時刻に noteOff を送って打ち消し、そのうえで `synth.stopAll()` を呼ぶ。
- **SFZ / サイン波**: Web Audio のトラック別 Gain→StereoPanner→Master 経路。`scheduleEnvelope()` で DAHDSR（SFZ は `ampeg_*`）を適用し、ノート終了後に release 分だけ余韻が鳴る。
- UI 部品の多くは `main.js` 内で `document.createElement` + インライン `style` で作られており、`style.css`・`index.html` のインライン CSS・`ui.js` のハードコード色の 3 系統にスタイルが分散している。

## 予定している改修（ユーザー要望）

1. ~~**再生エンジンの修正**~~: 完了。spessasynth に置き換え、先読みスケジューラーを導入した。
2. **パターン/ソング構成**: 現状は各トラックにピアノロールが続くだけ。DAW のように画面を切り替え、作成したパターンを並べて一曲を構成できるようにする（パターン編集画面とソング/アレンジ画面）。プロジェクト JSON 形式の変更が伴うため、旧形式の読み込み互換を考慮する。
3. **GUI の統一**: 分散しているスタイル（インライン style、index.html 内 CSS、canvas のハードコード色）を共通のデザイントークンに集約して見た目を統一する。

## 作業上の注意

- ゲームパッド操作が主要な入力手段。UI を変更する際は、ゲームパッドだけで全機能に到達できることを維持する（マウス/タッチ操作は補助）。
- 動作確認は手動（ブラウザ + ゲームパッド）。自動テストは無い。
- git で管理している（ブランチ `main`）。`main` への push は GitHub Pages へのデプロイになるので、push はユーザーの指示があるときだけ行う。
- 動作確認で音を出すときは、AudioContext の制約上ユーザー操作（クリック/ボタン）が必要。ヘッドレス Chrome で検証する場合は `--autoplay-policy=no-user-gesture-required` を付ける。
