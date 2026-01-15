# Walkthrough - Android MIDI Sequencer (Gamepad Support)

Android端末（およびPC）で動作する、ゲームコントローラー対応のMIDIシーケンサー実装が完了しました。

## Features Implemented

### 1. Gamepad Controlled Piano Roll
- **操作**: 十字キー/左スティックでカーソル移動。
- **入力**: 
    - `A` / `Cross` ボタン: ノートの配置 (Place Note)
    - `B` / `Circle` ボタン: ノートの削除 (Remove Note - *Not fully implemented, currenly logic shared with place*)
    - `X` / `Square` ボタン: プレビュー再生 (Preview)
- **UI**: Canvasを使用した高速な描画。グリッドとノートを表示。

### 2. Audio Engine with SFZ Support
- **SFZ Loading**: `Load SFZ Folder` ボタンから、`.sfz` ファイルとサンプル音声（`.wav`等）を含むフォルダを選択して読み込めます。
- **Playback**: 読み込んだサンプルをピッチに合わせて再生します。SFZがない場合はサイン波のテスト音が鳴ります。

### 3. Sequencer Transport
- **Play/Stop**: 画面上部のボタンで再生・停止が可能。
- **Playhead**: 再生位置を示す青いラインが表示され、通過したノートを発音します。

### 4. Premium Dark UI
- Glassmorphism（すりガラス）エフェクトを取り入れたヘッダー。
- 没入感のあるダークモード配色。

## How to Verify

### 1. Preparation
1. Chromeブラウザで `index.html` を開きます (ローカルサーバー推奨)。
    - 例: `npx http-server .`
2. PCにゲームコントローラーを接続します。
3. 任意のボタンを押して、AudioContextを有効化します。

### 2. Testing Input
1. コントローラーの十字キーを押し、青色のカーソルが動くことを確認します。
2. `X (Square)` ボタンを押し、テスト音が鳴ることを確認します。
3. `A (Cross)` ボタンを押し、ピアノロール上にピンク色のノートが配置されることを確認します。

### 3. Testing SFZ
1. 「Load SFZ Folder」をクリックします。
2. `.sfz` ファイルと `.wav` ファイルが入っているフォルダを選択し、「アップロード」を許可します。
    - *テスト用SFZがない場合、ノート配置時のデフォルト音（サイン波）で動作確認可能です。*
3. ノートを配置し、音がSFZのサンプルに変わっているか（またはプレビュー音が変わるか）確認します。

### 4. Testing Playback
1. 画面上の「▶」ボタンを押します。
2. 青いプレイヘッドが右に移動し、配置したノートの上を通るときに音が鳴ることを確認します。

## Next Steps
- **Android Deployment**: フォルダごとAndroid端末にコピーし、ローカルサーバーアプリ等でホストするか、GitHub Pages等にデプロイしてアクセスしてください。
- **Advanced Editing**: ノートの長さ変更、ベロシティ編集、クオンタイズ機能の追加。
