# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code 向けのガイドです。ユーザーとのやり取りは日本語で行う。

## プロジェクト概要

**GamePad MIDI Sequencer** — ゲームパッド（Gamepad API）で操作する、ブラウザ動作の MIDI シーケンサー PWA。
Android の Chrome での利用を主目的とし、PC ブラウザでも動作する。8 トラック。トラックごとのパターンをピアノロールで作り、ソング画面でクリップとして並べて曲にする。SF2/SFZ 再生、JSON プロジェクト保存、MIDI エクスポートを備える。
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
| `index.html` | エントリ。ヘッダー（画面タブ、再生/マーカー、プリセット、ADD/FILE メニュー）、`#piano-roll` canvas、HUD、トースト、共通ダイアログ、各モーダル。スタイルは持たない |
| `style.css` | 全スタイル。`:root` のデザイントークン（色・フォント・角丸・トラック色 `--track-1..8`）が**唯一の定義元** |
| `theme.js` | `loadTheme()` で CSS のトークンを読み込み、Canvas 描画用に `theme` / `font()` / `withAlpha()` / `trackColor()` を提供 |
| `main.js` | `App` クラス。状態（`songData`）、画面（`view`）切替、undo/redo、FILE/ADD メニューの**動的生成**、モーダル、保存/読込、MIDI 書き出し、メインループ |
| `song.js` | ソングのデータモデルと純粋関数（パターン/クリップの作成、`clipAt`、`forEachSongNote`、`flattenTrack` など）。DOM 非依存なので Node でテストできる |
| `song_view.js` | `SongView`。ソング画面（トラック×小節）の Canvas 描画とマウス操作。トラック色 `TRACK_COLORS` |
| `song_input.js` | `SongInput`。ソング画面のゲームパッド操作（`InputManager` から呼ばれる） |
| `ui.js` | `UIManager`。パターン画面（ピアノロール）の Canvas 描画。Canvas のサイズ/DPI 管理もここ（`SongView` は `app.ui.width/height` を使う） |
| `tone_editor.js` | `ToneEditor`。トラックごとの音色編集モーダル（SVG のノブとエンベロープ図、ゲームパッドは画面上の位置で項目間を移動）。開いている間は `InputManager.handleToneEditor()` が全入力を渡す |
| `input.js` | `InputManager`。Gamepad ポーリング、ボタンマッピング（localStorage `gamepad_mapping`）、共通ボタン（X/SELECT/START/L1/R1/L2）、ピアノロールの編集操作。ソング画面では `this.song`（`SongInput`）に委譲。**キーボード操作は未実装**（README の記載はあるがコードに無い） |
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
- 時間の単位は**拍（beat）**。ノートは `{ time, pitch, duration, velocity }`（time はパターン先頭からの拍）。
- **データモデル（version 2）**: `songData = { version, nextId, tracks, patterns, clips }`。パターンは 1 トラックに属する（`trackId`）。クリップは `{ trackId, patternId, start }` で、同じパターンを複数のクリップが参照する（リンク）。旧形式（トラックが notes を直接持つ version 1）は読み込み非対応（ユーザー判断）。
- **小節**: クリップは小節頭に置く。拍↔小節は `transport.barToBeat()` / `beatToBar()`（拍子変更対応）。パターン長の単位は曲頭の拍子の 1 小節（`getPatternBarLength()`）。
- **画面**: `app.view` が `'song'` か `'pattern'`。切替は `toggleView()`（SELECT 長押し / ヘッダーのタブ）、`openPattern(id, contextStart)`、`showSong()`。`patternContextStart` はパターンを開いた曲中の位置で、ゴーストノート（`getGhostNotes()`）とマーカー表示に使う。
- **ループ**: `app.loops.song` / `app.loops.pattern` を画面ごとに持ち、`app.loopRegion` / `app.isLooping` は現在の画面の値を返す getter/setter。パターン画面はサブループ未設定ならパターン全体をループ。
- `songData` は undo/redo で JSON 丸ごと差し替わるため、ノートやパターンのオブジェクト参照を長く保持しない（ID で引き直す）。
- トラック数は 8 固定（`song.js` の `TRACK_COUNT`、`audio.js` にも同値の定数）。
- **再生**: `App.startPlayback()` / `stopPlayback()` / `togglePlayback()` が入口。`App.loop()`（requestAnimationFrame）は毎フレーム `scheduler.update()` を呼び、`cardinalTime`（プレイヘッド）は `scheduler.currentBeat()` から AudioContext の時刻を基準に求める。スケジューラーは `app.forEachPlaybackNote()`（ソング画面=全クリップ、パターン画面=編集中パターン）と `app.getPlaybackLoop()` を使うので画面に依存しない。ミュート/ソロは予約時点で判定する（パターン画面ではミュート中でも鳴らす）。ソング画面はループ無しなら曲末で自動停止。
- **発音（SF2）**: トラック N = MIDI チャンネル N。音量/パンは CC7/CC10、音色は Bank Select (CC0/CC32) + Program Change、ドラムは `midiChannels[N].setDrums(true)`（プリセット一覧では bank 128 として扱う）。ADSR・フィルター・モジュレーター等はすべて spessasynth が SF2 仕様どおりに処理する。
- **トーン（`track.tone`）**: エンベロープ/フィルターは SoundFont の値からの**相対値**（-64..63、0 = プリセットのまま）。`audio.js` の `toneControllerMessages()` が標準 MIDI メッセージ（CC73/75/72 = A/D/R、CC74/71 = Cutoff/Resonance、CC91/93/94 = Reverb/Chorus/Delay、SF2 NRPN 120 で sustainVolEnv のオフセット、RPN 2/1 = Transpose/Fine）に変換し、ライブ再生と MIDI 書き出しの両方で同じものを使う。SFZ/サイン波ではエンベロープと Tune のみ `applyToneToEnvelope()` と detune で近似。undo/読み込み後は `app.applyAllTrackSettings()` で音量・パン・トーンを再送する。古いプロジェクトの欠けたフィールドは `normalizeSong()` で補う。
- **停止**: spessasynth の予約済みイベントは取り消せないため、`AudioManager.stopAll()` は未来の noteOn と同時刻に noteOff を送って打ち消し、そのうえで `synth.stopAll()` を呼ぶ。
- **SFZ / サイン波**: Web Audio のトラック別 Gain→StereoPanner→Master 経路。`scheduleEnvelope()` で DAHDSR（SFZ は `ampeg_*`）を適用し、ノート終了後に release 分だけ余韻が鳴る。
- **GUI の決まり**: 色・フォントは `style.css` の `:root` トークンだけで定義する。Canvas では `theme.js` 経由で参照し、JS/HTML に色コードやインライン `style` を直接書かない（トラック色のスウォッチのようなデータ由来の値は例外）。ボタンは `.btn`（`.icon` / `.primary` / `.small` / `.active`）、メニューは `.menu` + `[data-menu-toggle]` + `.menu-item[data-action]`（処理は `main.js` の `setupMenus()`）、モーダルは `.modal` に `.open` を付け外しする。
- **ダイアログ**: `alert` / `prompt` / `confirm` は使わず `app.showDialog({ title, message, input, cancel })`（Promise）/ `app.showAlert()` / `app.showToast()` を使う。ダイアログ表示中はゲームパッドの A/B が OK/キャンセルになり、閉じた後は A/B を離すまでエディター側に入力を渡さない（`input.js` の `waitForRelease`）。

## 予定している改修（ユーザー要望）

1. ~~**再生エンジンの修正**~~: 完了。spessasynth に置き換え、先読みスケジューラーを導入した。
2. ~~**パターン/ソング構成**~~: 完了。トラックごとのパターン、可変長（小節単位）、旧形式の互換なし。
3. ~~**GUI の統一**~~: 完了。デザイントークンを `style.css` に集約し、Canvas・HTML・ダイアログを統一した。

## 作業上の注意

- ゲームパッド操作が主要な入力手段。UI を変更する際は、ゲームパッドだけで全機能に到達できることを維持する（マウス/タッチ操作は補助）。
- 動作確認は手動（ブラウザ + ゲームパッド）。リポジトリ内に自動テストは無い。検証するときは、`song.js` / `transport.js` / `scheduler.js` を Node で直接 import して単体テストし、UI は puppeteer-core + ローカルの Chrome で `navigator.getGamepads` を偽のゲームパッドに差し替えて操作する（テスト用ファイルはリポジトリに置かない）。
- git で管理している（ブランチ `main`）。`main` への push は GitHub Pages へのデプロイになるので、push はユーザーの指示があるときだけ行う。
- 動作確認で音を出すときは、AudioContext の制約上ユーザー操作（クリック/ボタン）が必要。ヘッドレス Chrome で検証する場合は `--autoplay-policy=no-user-gesture-required` を付ける。
