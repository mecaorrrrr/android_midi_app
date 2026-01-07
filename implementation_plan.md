# Implementation Plan - Android MIDI Sequencer with Gamepad Support

Android端末上で動作し、ゲームコントローラーで操作可能なピアノロールアプリを開発します。
迅速なプロトタイピングとクロスプラットフォーム互換性のため、Web技術（HTML5/JavaScript）を使用したPWA（Progressive Web App）として構築します。これにより、Android端末のChromeブラウザや「ホーム画面に追加」機能を通じてアプリとして動作させることが可能です。

## User Review Required
> [!NOTE]
> **Web技術による実装の提案**:
> ネイティブAndroidアプリ（Kotlin/Java）ではなく、Web技術（Web Audio API, Gamepad API）を使用します。これによりWindows（開発環境）ですぐに動作確認ができ、そのままAndroidでも動作します。SFZファイルはセキュリティ制約上、ユーザーにファイルを選択してもらう形で読み込みます。

## Proposed Changes

### Core Structure
#### [NEW] [index.html](file:///C:/Users/MECAO/.gemini/antigravity/scratch/android_midi_app/index.html)
- アプリケーションのメインエントリポイント
- Canvas要素（ピアノロール用）
- モバイル対応設定（viewport metaタグ）

#### [NEW] [style.css](file:///C:/Users/MECAO/.gemini/antigravity/scratch/android_midi_app/style.css)
- ダークモードベースの「Premium」なUIデザイン
- フルスクリーン対応、タッチ操作禁止（コントローラー操作メインのため誤操作防止）

#### [NEW] [main.js](file:///C:/Users/MECAO/.gemini/antigravity/scratch/android_midi_app/main.js)
- アプリケーションの初期化とメインループ

### Modules (JS)
#### [NEW] [audio.js](file:///C:/Users/MECAO/.gemini/antigravity/scratch/android_midi_app/audio.js)
- Web Audio APIの管理
- SFZファイルのパースとサンプル再生ロジック
- スケジューリング（再生）機能

#### [NEW] [input.js](file:///C:/Users/MECAO/.gemini/antigravity/scratch/android_midi_app/input.js)
- Gamepad APIのラッパー
- コントローラーの状態管理（詳細なボタンマッピング）
- カーソル移動の加速処理などUI操作ロジック

#### [NEW] [ui.js](file:///C:/Users/MECAO/.gemini/antigravity/scratch/android_midi_app/ui.js)
- HTML5 Canvasへのピアノロール描画
- グリッド、ノート、カーソルのレンダリング
- ズーム・スクロール状態の管理

## Verification Plan

### Manual Verification
1.  **PCでの動作確認**:
    - USB/Bluetoothコントローラーを接続し、ブラウザで操作できるか確認。
    - 音が鳴るか確認。
2.  **Androidでの動作確認**:
    - コード修正後、必要であればローカルサーバーを立ててAndroid端末からアクセス、またはファイルを転送して確認（ローカルファイルアクセス制限に注意が必要なので、ローカルサーバー推奨）。
    - *※今回は開発環境がWindowsのみと想定されるため、PC上のChromeのDevToolsとGamepad入力でエミュレーション確認を行います。*

### Automated Tests
- 特になし（UI/インタラクション重視のため手動テストメイン）
