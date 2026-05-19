# 技術スタック

## プロジェクト概要
GitHub Issue Semantic Search - Chrome拡張機能でGitHubのIssuesをセマンティック検索・同期するアプリケーション

## フロントエンド

### UI フレームワーク
- **HTML/CSS/JavaScript** - Vanilla
- **Chrome Side Panel API** - サイドパネルとしてUIを表示

### ローカルストレージ
- **IndexedDB** - Issue データのクライアント側永続化
  - DB Name: `GitHubIssueSearchDB`
  - Store: `issues`
  - Version: 1

## バックエンド / Service Worker

### 実行環境
- **Chrome Extension (Manifest V3)**
- **Service Worker** (background.js) - バックグラウンド処理

### 外部API
- **GitHub API** - Issueデータ取得
- **Hugging Face API** (via CDN) - モデルダウンロード

## ライブラリ・依存関係

### 主要依存
```json
{
  "@huggingface/transformers": "^3.0.2"
}
```

### 機械学習 / NLP
- **Hugging Face Transformers** 
  - モデル: `Xenova/all-MiniLM-L6-v2` (推定)
  - 用途: テキストをベクトル化 → セマンティック検索

### 検索アルゴリズム
- **BM25** - 字句検索（Lexical Search）
  - パラメータ: k1=1.5, b=0.75
- **Reciprocal Rank Fusion (RRF)** - 複数ランキングの統合
  - パラメータ: k=60
- **ハイブリッド検索** - セマンティック + 字句検索の結合

## パフォーマンス設定

| 設定 | 値 | 説明 |
|------|-----|------|
| `SEARCH_DEBOUNCE_MS` | 350ms | 検索入力のデバウンス時間 |
| `SEARCH_LIMIT` | 10 | 検索結果の最大件数 |
| `CHUNK_CHAR_LIMIT` | 900 | テキストチャンクのサイズ |
| `CHUNK_OVERLAP` | 160 | チャンク間のオーバーラップ |

## セキュリティ

### Permission
- `sidePanel` - サイドパネル表示
- `storage` - 拡張データ保存

### Host Permissions
- `https://api.github.com/*` - GitHub API
- `https://huggingface.co/*` - Hugging Face CDN

### Content Security Policy
```
script-src 'self' 'wasm-unsafe-eval'; object-src 'self'
```

## データフロー

1. **同期** → GitHub API から Issue データ取得
2. **インデックス** → IndexedDB に格納
3. **検索** → 入力テキストをベクトル化 → BM25 + RRF で検索
4. **結果表示** → UI に結果を表示

## 拡張機能の特徴

- ✅ オフライン検索対応（IndexedDB）
- ✅ セマンティック・字句混合検索
- ✅ ローカル処理（プライベート）
- ✅ リアルタイム同期
- ✅ データエクスポート機能
