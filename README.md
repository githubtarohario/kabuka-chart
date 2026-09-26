# 株価ダッシュボード (kabuka-chart)

日本株の株価チャート・マーケット概況・経済ニュースを 1 画面で確認できる、ローカル実行型の Flask Web アプリです。
株価データは [yfinance](https://github.com/ranaroussi/yfinance)（Yahoo! Finance）から取得します。

## 主な機能

- **個別銘柄チャート**
  - ローソク足チャート＋移動平均線（5日 / 25日 / 75日）
  - 表示期間の切り替え: 3M / 6M / 1Y / 2Y / 5Y
  - 日次データ表（前日比・騰落率・出来高増減率・値幅・ギャップ・売買代金・移動平均乖離率など）
  - 日次データの **CSV 出力**
- **ウォッチリスト**
  - 銘柄コード（例: `7203`）で追加・削除。登録内容は `data/stocks.json` に保存されます
  - 日経225構成銘柄なら銘柄名を自動で補完します
- **マーケット概況**
  - 為替レート: USD/JPY、EUR/JPY、EUR/USD
  - 日経225 業種別ヒートマップ（構成銘柄は日経の公式サイトから取得し、`data/nk225_components.json` にキャッシュ）
- **経済・株価ニュース**
  - NHK 経済、Yahoo! ニュース（経済トピックス / 経済総合）の RSS を集約

## 必要環境

- Python 3.10 以上
- インターネット接続

## セットアップ

```bash
git clone https://github.com/githubtarohario/kabuka-chart.git
cd kabuka-chart
pip install -r requirements.txt
```

## 起動方法

```bash
python app.py
```

ブラウザで http://127.0.0.1:5000 を開きます。

Windows では `start.bat` をダブルクリックすると、サーバーの起動とブラウザの表示を一度に行えます。

起動直後はヒートマップ・為替・ニュースをバックグラウンドで取得するため、最初の表示までに少し時間がかかることがあります。
画面右上の「↻ データ更新」を押すと、キャッシュを破棄して最新データを取得し直します。

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/stocks` | ウォッチリストの一覧 |
| POST | `/api/stocks` | 銘柄を追加（`{"code": "7203", "name": "任意"}`） |
| DELETE | `/api/stocks/<code>` | 銘柄を削除 |
| GET | `/api/stock/<code>?period=6mo` | 株価・移動平均・日次指標 |
| GET | `/api/heatmap` | 日経225 業種別ヒートマップ（30分キャッシュ） |
| GET | `/api/fx` | 為替レート（1分キャッシュ） |
| GET | `/api/news` | ニュース一覧（10分キャッシュ） |
| POST | `/api/refresh` | キャッシュをクリア |

## ディレクトリ構成

```
.
├── app.py              # Flask アプリ本体（データ取得・API）
├── start.bat           # Windows 用起動スクリプト
├── requirements.txt
├── data/
│   ├── stocks.json             # ウォッチリスト
│   └── nk225_components.json   # 日経225構成銘柄のキャッシュ
├── static/
│   ├── app.js          # フロントエンド（TradingView Lightweight Charts を使用）
│   └── style.css
└── templates/
    └── index.html
```

## 補足

- Avast / AVG などのウイルス対策ソフトが HTTPS 通信を検査している環境でも動くよう、ローカルのルート証明書を certifi の証明書バンドルに追加して通信します。
- Yahoo! Finance の日足終値は反映が遅れることがあります。その場合、ヒートマップは 5 分足の最新値で暫定的に補完します。
- 表示されるデータは参考情報です。投資判断はご自身の責任で行ってください。
