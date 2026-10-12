# tf-adviser

tenfour-poker.com のプリフロップをリアルタイムで補佐する CDP スクリプト。

Chrome DevTools Protocol (CDP) でブラウザを外部から監視し、ハンド・ポジション・アクション状況を読み取って GTO レンジに基づくアドバイスをオーバーレイ表示する。CSP の制限を受けない。

---

## 動作概要

- **レンジ参照**: 6-max 100bb キャッシュ。RFI / vs open / vs 3bet / vs 4bet の 44 シナリオ
- **オーバーレイ**: 画面右下にハンド・推奨アクション・頻度バー・レンジグリッドを表示
- **自動フォールド**: fold 90% 以上（かつ両カードが Q 未満）のとき `f` キーを発火
- **自動オープン**: RFI で raise 90% 以上のとき、自分のターンになったら `3 → Enter` を発火
- **フロップ以降**: コミュニティカードが 3 枚以上出たら処理を停止（パネルはそのまま残る）

---

## 必要なもの

- Node.js 24（`mise` で管理）
- Google Chrome

---

## セットアップ

```bash
# リポジトリをクローン
git clone git@github.com:EgTheGoat/tf-adviser.git
cd tf-adviser

# Node.js バージョンを合わせる（mise を使う場合）
mise install
```

依存パッケージなし。Node.js 24 の組み込み WebSocket のみ使用。

---

## 使い方

### 1. Chrome をデバッグモードで起動

既存の Chrome をすべて終了してから実行する。

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-cdp
```

### 2. tenfour-poker.com を開いてテーブルに着席

### 3. スクリプトを起動

```bash
node gto_cdp.mjs
```

起動するとブラウザ右下にパネルが表示される。

---

## パネルの見方

```
HJ · RFI
AKo
▶ レイズ/3bet

レイズ/3bet  ████████████████████  95%
フォールド   █                      5%
```

上部にはその状況のレンジグリッド（13×13）が表示される。

- **赤**: レイズ頻度
- **緑**: コール頻度
- **暗色**: フォールド
- **白枠**: 現在のハンド

### シナリオ表示例

| 表示 | 意味 |
|------|------|
| `BTN · RFI` | BTN からのオープン |
| `CO · vs UTG` | UTG オープンに対する CO |
| `HJ · vs BB 3bet` | HJ がオープンして BB に 3bet された |
| `BB オプション` | BB がオープン待ち（誰もレイズしていない） |

---

## 自動アクション仕様

| 条件 | アクション |
|------|-----------|
| fold 90% 以上 かつ 両カードが Q 未満 | `f` キーを発火（Fast Fold / Fold ボタン） |
| RFI で raise 90% 以上 | 自分のターンになったら `3` → 2.5bb/3bb 表示後 1 秒待って `Enter` |
| 混合戦略（どちらも 90% 未満） | 手動 |
| 両カードとも Q 以上（AK, AQ, KQ, QQ+ 等） | 常に手動 |

---

## レンジデータ

`gto_ranges_bundle.json` に 44 シナリオをバンドル済み。GTOレンジは近似解の一例。
