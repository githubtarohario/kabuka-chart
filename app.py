"""株価ダッシュボード (Flask)

起動:  python app.py  →  http://127.0.0.1:5000
"""
import json
import math
import os
import tempfile
import threading
import time
import warnings
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

warnings.filterwarnings("ignore")

import certifi
import pandas as pd
from bs4 import BeautifulSoup
from curl_cffi import requests as cr
from flask import Flask, jsonify, render_template, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STOCKS_FILE = os.path.join(DATA_DIR, "stocks.json")
NK225_CACHE_FILE = os.path.join(DATA_DIR, "nk225_components.json")
os.makedirs(DATA_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# SSL: ウイルス対策ソフト(Avast等)がHTTPSを検査している環境でも通信できるよう、
# certifi の証明書にローカルのルート証明書を追加したバンドルを作る。
# curl は日本語パスを扱えないため、ASCIIパスの一時フォルダに置く。
# ---------------------------------------------------------------------------
def _build_ca_bundle():
    extra = [
        r"C:\ProgramData\Avast Software\Avast\wscert.pem",
        r"C:\ProgramData\AVG\Antivirus\wscert.pem",
        os.environ.get("NODE_EXTRA_CA_CERTS", ""),
    ]
    path = os.path.join(tempfile.gettempdir(), "kabu_ca_bundle.pem")
    with open(certifi.where(), "rb") as f:
        data = f.read()
    for p in extra:
        if p and os.path.isfile(p):
            with open(p, "rb") as f:
                data += b"\n" + f.read()
    with open(path, "wb") as f:
        f.write(data)
    return path


CA_BUNDLE = _build_ca_bundle()
os.environ["SSL_CERT_FILE"] = CA_BUNDLE
os.environ["REQUESTS_CA_BUNDLE"] = CA_BUNDLE

import yfinance as yf  # noqa: E402  (SSL設定後に読み込む)

SESSION = cr.Session(impersonate="chrome", verify=CA_BUNDLE)

app = Flask(__name__)
app.json.ensure_ascii = False


# ---------------------------------------------------------------------------
# 簡易キャッシュ
# ---------------------------------------------------------------------------
_cache = {}
_cache_lock = threading.Lock()


def cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fn()
    with _cache_lock:
        _cache[key] = (now, value)
    return value


def num(v, digits=2):
    """NaN/None を None にし、JSON化できる数値に丸める"""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, digits)


def to_ticker(code):
    code = code.strip().upper()
    if code.startswith("^") or "." in code or "=" in code:
        return code
    return code + ".T"


# ---------------------------------------------------------------------------
# 日経225 構成銘柄 (日経公式サイトから取得。失敗時は前回保存分を使う)
# ---------------------------------------------------------------------------
def load_nk225_components():
    def fetch():
        try:
            r = SESSION.get(
                "https://indexes.nikkei.co.jp/nkave/index/component?idx=nk225", timeout=20
            )
            r.raise_for_status()
            soup = BeautifulSoup(r.text, "lxml")
            result = []
            for block in soup.select("div.idx-index-components"):
                h = block.find("h3")
                if not h:
                    continue
                sector = h.get_text(strip=True)
                for tr in block.select("tbody tr"):
                    tds = [td.get_text(strip=True) for td in tr.find_all("td")]
                    if len(tds) >= 3:
                        result.append({"code": tds[0], "name": tds[1], "company": tds[2], "sector": sector})
            if len(result) >= 200:
                with open(NK225_CACHE_FILE, "w", encoding="utf-8") as f:
                    json.dump(result, f, ensure_ascii=False, indent=1)
                return result
        except Exception as e:  # noqa: BLE001
            print("[nk225] 取得失敗:", e)
        if os.path.isfile(NK225_CACHE_FILE):
            with open(NK225_CACHE_FILE, encoding="utf-8") as f:
                return json.load(f)
        return []

    return cached("nk225_components", 24 * 3600, fetch)


def name_for(code):
    for c in load_nk225_components():
        if c["code"] == code:
            return c["name"]
    return None


# ---------------------------------------------------------------------------
# 登録銘柄
# ---------------------------------------------------------------------------
_stocks_lock = threading.Lock()


def read_stocks():
    if not os.path.isfile(STOCKS_FILE):
        default = [
            {"code": "7203", "name": "トヨタ自動車"},
            {"code": "6758", "name": "ソニーグループ"},
            {"code": "9984", "name": "ソフトバンクグループ"},
            {"code": "8306", "name": "三菱UFJ FG"},
        ]
        write_stocks(default)
        return default
    with open(STOCKS_FILE, encoding="utf-8") as f:
        return json.load(f)


def write_stocks(stocks):
    with open(STOCKS_FILE, "w", encoding="utf-8") as f:
        json.dump(stocks, f, ensure_ascii=False, indent=2)


@app.get("/api/stocks")
def api_stocks():
    return jsonify(read_stocks())


@app.post("/api/stocks")
def api_add_stock():
    body = request.get_json(force=True)
    code = str(body.get("code", "")).strip().upper()
    if not code:
        return jsonify({"error": "銘柄コードを入力してください"}), 400
    with _stocks_lock:
        stocks = read_stocks()
        if any(s["code"] == code for s in stocks):
            return jsonify({"error": f"{code} は登録済みです"}), 400
        name = (body.get("name") or "").strip() or name_for(code)
        # 存在確認 + 名前取得
        hist = yf.Ticker(to_ticker(code), session=SESSION).history(period="5d")
        if hist.empty:
            return jsonify({"error": f"{code} の株価が取得できませんでした"}), 400
        if not name:
            try:
                info = yf.Ticker(to_ticker(code), session=SESSION).info
                name = info.get("shortName") or info.get("longName") or code
            except Exception:  # noqa: BLE001
                name = code
        stocks.append({"code": code, "name": name})
        write_stocks(stocks)
    return jsonify(stocks)


@app.delete("/api/stocks/<code>")
def api_delete_stock(code):
    with _stocks_lock:
        stocks = [s for s in read_stocks() if s["code"] != code]
        write_stocks(stocks)
    return jsonify(stocks)


# ---------------------------------------------------------------------------
# 機能1: 個別銘柄の株価 (ローソク足 + 移動平均 + 詳細テーブル)
# ---------------------------------------------------------------------------
PERIODS = {"3mo", "6mo", "1y", "2y", "5y", "max"}


def fetch_stock(code, period):
    t = yf.Ticker(to_ticker(code), session=SESSION)
    # 移動平均を期間の頭から正しく出すため、25営業日ぶん余分に取得する
    fetch_period = {"3mo": "6mo", "6mo": "1y", "1y": "2y", "2y": "5y", "5y": "10y"}.get(period, period)
    df = t.history(period=fetch_period, auto_adjust=False)
    if df.empty:
        return None
    df = df.dropna(subset=["Close"])
    df.index = df.index.tz_localize(None)

    df["MA5"] = df["Close"].rolling(5).mean()
    df["MA25"] = df["Close"].rolling(25).mean()
    df["MA75"] = df["Close"].rolling(75).mean()
    df["PrevClose"] = df["Close"].shift(1)
    df["Change"] = df["Close"] - df["PrevClose"]
    df["ChangePct"] = df["Change"] / df["PrevClose"] * 100
    df["VolChangePct"] = (df["Volume"] / df["Volume"].shift(1) - 1) * 100
    df["Range"] = df["High"] - df["Low"]
    df["RangePct"] = df["Range"] / df["PrevClose"] * 100
    df["Gap"] = df["Open"] - df["PrevClose"]
    df["Turnover"] = df["Close"] * df["Volume"]
    df["Dev5"] = (df["Close"] / df["MA5"] - 1) * 100
    df["Dev25"] = (df["Close"] / df["MA25"] - 1) * 100

    # 表示期間に絞る
    days = {"3mo": 92, "6mo": 183, "1y": 366, "2y": 731, "5y": 1827}.get(period)
    if days:
        start = df.index[-1] - pd.Timedelta(days=days)
        view = df[df.index >= start]
    else:
        view = df

    rows = []
    for idx, r in view.iterrows():
        rows.append({
            "date": idx.strftime("%Y-%m-%d"),
            "open": num(r["Open"]), "high": num(r["High"]), "low": num(r["Low"]), "close": num(r["Close"]),
            "adjClose": num(r.get("Adj Close")),
            "volume": int(r["Volume"]) if not math.isnan(r["Volume"]) else None,
            "prevClose": num(r["PrevClose"]), "change": num(r["Change"]), "changePct": num(r["ChangePct"]),
            "volChangePct": num(r["VolChangePct"]), "range": num(r["Range"]), "rangePct": num(r["RangePct"]),
            "gap": num(r["Gap"]), "turnover": num(r["Turnover"], 0),
            "ma5": num(r["MA5"]), "ma25": num(r["MA25"]), "ma75": num(r["MA75"]),
            "dev5": num(r["Dev5"]), "dev25": num(r["Dev25"]),
            "dividend": num(r.get("Dividends")), "split": num(r.get("Stock Splits")),
        })

    # 概要 (取れなくても本体は返す)
    summary = {}
    try:
        info = cached(f"info:{code}", 3600, lambda: t.info)
        summary = {
            "longName": info.get("longName") or info.get("shortName"),
            "sector": info.get("sector"), "industry": info.get("industry"),
            "marketCap": info.get("marketCap"),
            "per": num(info.get("trailingPE")), "forwardPer": num(info.get("forwardPE")),
            "pbr": num(info.get("priceToBook")),
            "dividendYield": num(info.get("dividendYield")),
            "eps": num(info.get("trailingEps")), "bps": num(info.get("bookValue")),
            "roe": num((info.get("returnOnEquity") or 0) * 100) if info.get("returnOnEquity") else None,
            "beta": num(info.get("beta")),
            "avgVolume": info.get("averageVolume"),
            "sharesOutstanding": info.get("sharesOutstanding"),
        }
    except Exception as e:  # noqa: BLE001
        print("[info] 取得失敗:", code, e)

    last = df.iloc[-1]
    y52 = df[df.index >= df.index[-1] - pd.Timedelta(days=365)]
    summary.update({
        "close": num(last["Close"]), "change": num(last["Change"]), "changePct": num(last["ChangePct"]),
        "open": num(last["Open"]), "high": num(last["High"]), "low": num(last["Low"]),
        "volume": int(last["Volume"]), "turnover": num(last["Turnover"], 0),
        "ma5": num(last["MA5"]), "ma25": num(last["MA25"]),
        "high52": num(y52["High"].max()), "low52": num(y52["Low"].min()),
        "lastDate": df.index[-1].strftime("%Y-%m-%d"),
    })
    return {"code": code, "rows": rows, "summary": summary}


@app.get("/api/stock/<code>")
def api_stock(code):
    period = request.args.get("period", "6mo")
    if period not in PERIODS:
        period = "6mo"
    try:
        data = cached(f"stock:{code}:{period}", 300, lambda: fetch_stock(code, period))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500
    if not data:
        return jsonify({"error": "データが取得できませんでした"}), 404
    return jsonify(data)


# ---------------------------------------------------------------------------
# 機能2: 日経225 分野別ヒートマップ / 為替
# ---------------------------------------------------------------------------
def fetch_heatmap():
    comps = load_nk225_components()
    if not comps:
        return {"error": "日経225構成銘柄を取得できませんでした"}
    tickers = [to_ticker(c["code"]) for c in comps]
    df = yf.download(tickers + ["^N225"], period="10d", auto_adjust=False,
                     progress=False, session=SESSION, threads=8)
    close = df["Close"].copy()
    volume = df["Volume"]

    # Yahooは日足の終値が数日遅れて入ることがある (出来高だけ先に入り終値がNaN)。
    # その場合は5分足の最終値で暫定的に補う。
    provisional_day = None
    last = close.index[-1]
    if close.loc[last].isna().mean() > 0.5:
        # 一括取得は一部の銘柄を取りこぼすことがあるので、欠けた銘柄だけ取り直す
        for threads in (8, 4, False):
            missing = [t for t in close.columns if pd.isna(close.at[last, t])]
            if not missing:
                break
            intra = yf.download(missing, period="5d", interval="5m", auto_adjust=False,
                                progress=False, session=SESSION, threads=threads)["Close"]
            if isinstance(intra, pd.Series):
                intra = intra.to_frame(missing[0])
            intra.index = intra.index.tz_convert("Asia/Tokyo")
            bars = intra[intra.index.date == last.date()]
            if not bars.empty:
                close.loc[last] = close.loc[last].fillna(bars.ffill().iloc[-1])
                provisional_day = last

    # 「前日」= 直近で取引が確定した営業日。当日分が取引中なら1日前を使う
    n225 = close["^N225"].dropna()
    now = pd.Timestamp.now(tz="Asia/Tokyo")
    target_idx = len(n225) - 1
    last_day = n225.index[-1]
    if last_day.date() == now.date() and (now.hour, now.minute) < (15, 30):
        target_idx -= 1
    day = n225.index[target_idx]
    prev_day = n225.index[target_idx - 1]

    def pct(series):
        a, b = series.get(day), series.get(prev_day)
        if a is None or b is None or math.isnan(a) or math.isnan(b) or b == 0:
            return None
        return (a / b - 1) * 100

    stocks = []
    for c, tk in zip(comps, tickers):
        if tk not in close:
            continue
        s = close[tk]
        p = pct(s)
        cl = s.get(day)
        vol = volume[tk].get(day)
        stocks.append({
            **c, "changePct": num(p), "close": num(cl),
            "turnover": num((cl or 0) * (vol or 0), 0) if cl is not None and vol is not None and not math.isnan(vol) else None,
        })

    sectors = {}
    for s in stocks:
        sectors.setdefault(s["sector"], []).append(s)
    sector_list = []
    for name, items in sectors.items():
        vals = [i["changePct"] for i in items if i["changePct"] is not None]
        sector_list.append({
            "sector": name,
            "changePct": num(sum(vals) / len(vals)) if vals else None,
            "stocks": sorted(items, key=lambda i: -(i["turnover"] or 0)),
        })

    return {
        "date": day.strftime("%Y-%m-%d"),
        "prevDate": prev_day.strftime("%Y-%m-%d"),
        "provisional": provisional_day is not None and day == provisional_day,
        "nikkei": {"close": num(n225.iloc[target_idx]), "changePct": num(pct(close["^N225"]))},
        "sectors": sector_list,
    }


@app.get("/api/heatmap")
def api_heatmap():
    try:
        return jsonify(cached("heatmap", 1800, fetch_heatmap))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500


FX_PAIRS = [
    ("USDJPY=X", "米ドル / 円", "USD/JPY"),
    ("EURJPY=X", "ユーロ / 円", "EUR/JPY"),
    ("EURUSD=X", "ユーロ / 米ドル", "EUR/USD"),
]


def fetch_fx():
    tks = [p[0] for p in FX_PAIRS]
    daily = yf.download(tks, period="3mo", interval="1d", progress=False, session=SESSION)["Close"]
    intraday = yf.download(tks, period="1d", interval="5m", progress=False, session=SESSION)["Close"]
    out = []
    for tk, label, short in FX_PAIRS:
        d = daily[tk].dropna()
        i = intraday[tk].dropna() if tk in intraday else d
        cur = float(i.iloc[-1]) if len(i) else float(d.iloc[-1])
        ts = i.index[-1] if len(i) else d.index[-1]
        # 前日終値: 当日(日付が最新)の足を除いた最後の日足
        prev = float(d.iloc[-2]) if len(d) >= 2 else None
        digits = 4 if "USD" == short[-3:] else 3
        out.append({
            "symbol": short, "label": label, "rate": num(cur, digits),
            "prevClose": num(prev, digits),
            "change": num(cur - prev, digits) if prev else None,
            "changePct": num((cur / prev - 1) * 100) if prev else None,
            "time": ts.tz_convert("Asia/Tokyo").strftime("%Y-%m-%d %H:%M") if ts.tzinfo else str(ts)[:16],
            "history": [{"time": ix.strftime("%Y-%m-%d"), "value": num(v, digits)} for ix, v in d.items()],
        })
    return out


@app.get("/api/fx")
def api_fx():
    try:
        return jsonify(cached("fx", 60, fetch_fx))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# 機能3: 経済・株価ニュース (RSS)
# ---------------------------------------------------------------------------
NEWS_FEEDS = [
    ("NHK 経済", "https://www3.nhk.or.jp/rss/news/cat5.xml"),
    ("Yahoo! 経済トピックス", "https://news.yahoo.co.jp/rss/topics/business.xml"),
    ("Yahoo! 経済総合", "https://news.yahoo.co.jp/rss/categories/business.xml"),
]


def fetch_news():
    items = []
    for source, url in NEWS_FEEDS:
        try:
            r = SESSION.get(url, timeout=15)
            root = ET.fromstring(r.content)
            for it in root.iter("item"):
                title = (it.findtext("title") or "").strip()
                link = (it.findtext("link") or "").strip()
                pub = it.findtext("pubDate")
                ts = None
                if pub:
                    try:
                        ts = parsedate_to_datetime(pub).timestamp()
                    except Exception:  # noqa: BLE001
                        pass
                desc = BeautifulSoup(it.findtext("description") or "", "lxml").get_text(" ", strip=True)
                items.append({"source": source, "title": title, "link": link, "ts": ts, "description": desc[:200]})
        except Exception as e:  # noqa: BLE001
            print("[news] 取得失敗:", source, e)

    # 登録銘柄の関連ニュース (Yahoo Finance)
    for s in read_stocks():
        try:
            for n in (yf.Ticker(to_ticker(s["code"]), session=SESSION).news or [])[:5]:
                c = n.get("content", n)
                pub = c.get("pubDate") or c.get("providerPublishTime")
                ts = None
                if isinstance(pub, (int, float)):
                    ts = pub
                elif pub:
                    ts = pd.Timestamp(pub).timestamp()
                link = (c.get("canonicalUrl") or {}).get("url") or c.get("link")
                items.append({
                    "source": f"銘柄: {s['name']}", "title": c.get("title", ""), "link": link,
                    "ts": ts, "description": (c.get("summary") or "")[:200],
                })
        except Exception as e:  # noqa: BLE001
            print("[news] 銘柄ニュース取得失敗:", s["code"], e)

    seen, uniq = set(), []
    for i in sorted(items, key=lambda x: -(x["ts"] or 0)):
        if i["title"] in seen:
            continue
        seen.add(i["title"])
        uniq.append(i)
    return uniq


@app.get("/api/news")
def api_news():
    return jsonify(cached("news", 600, fetch_news))


@app.post("/api/refresh")
def api_refresh():
    with _cache_lock:
        for k in [k for k in _cache if k != "nk225_components"]:
            del _cache[k]
    return jsonify({"ok": True})


@app.get("/")
def index():
    return render_template("index.html")


def _prefetch():
    """時間のかかるヒートマップ等を起動直後に裏で取得しておく"""
    for key, ttl, fn in [("heatmap", 1800, fetch_heatmap), ("fx", 60, fetch_fx), ("news", 600, fetch_news)]:
        try:
            cached(key, ttl, fn)
        except Exception as e:  # noqa: BLE001
            print("[prefetch]", key, e)


if __name__ == "__main__":
    threading.Thread(target=_prefetch, daemon=True).start()
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
