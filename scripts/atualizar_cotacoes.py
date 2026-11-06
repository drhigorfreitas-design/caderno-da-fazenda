#!/usr/bin/env python3
"""Atualiza cotacoes.json com boi gordo e milho (B3), Selic e dólar (Banco Central) e reposição de macho e fêmea Nelore em MT (Scot).
Fonte: páginas públicas do Notícias Agrícolas. Se uma parte falhar, mantém o valor antigo dela."""
import json, re, sys, os, urllib.request
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser

BASE = "https://www.noticiasagricolas.com.br/cotacoes/"
FONTES = {
    "boi": BASE + "boi-gordo/boi-gordo-b3-prego-regular",
    "milho": BASE + "milho/milho-b3-prego-regular",
    "desmama": BASE + "boi-gordo/macho-nelore-desmama-8-meses",
    "bezerro": BASE + "boi-gordo/macho-nelore-bezerro-12-meses",
    "garrote": BASE + "boi-gordo/macho-nelore-garrote-18-meses",
    "magro": BASE + "boi-gordo/macho-nelore-boi-magro",
    "f_desmama": BASE + "boi-gordo/femea-nelore-desmama-8-meses",
    "f_bezerra": BASE + "boi-gordo/bezerra-nelore-femea-12-meses",
    "f_novilha": BASE + "boi-gordo/femea-nelore-novilha-18-meses",
    "f_vaca": BASE + "boi-gordo/femea-nelore-vaca-boiadeira",
}
MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
ABREV = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cotacoes.json")

class Tabelas(HTMLParser):
    def __init__(self):
        super().__init__(); self.tabelas = []; self._t = None; self._r = None; self._c = None; self.texto = []
    def handle_starttag(self, tag, a):
        if tag == "table": self._t = []
        elif tag == "tr" and self._t is not None: self._r = []
        elif tag in ("td", "th") and self._r is not None: self._c = []
    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._c is not None and self._r is not None:
            self._r.append(" ".join("".join(self._c).split())); self._c = None
        elif tag == "tr" and self._r is not None and self._t is not None:
            if self._r: self._t.append(self._r)
            self._r = None
        elif tag == "table" and self._t is not None:
            self.tabelas.append(self._t); self._t = None
    def handle_data(self, d):
        self.texto.append(d)
        if self._c is not None: self._c.append(d)

def baixar(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Accept-Language": "pt-BR,pt;q=0.9"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("utf-8", "replace")

def num(s):
    s = re.sub(r"[^\d,.\-]", "", s or "")
    if not s or s in "-.,": return None
    return float(s.replace(".", "").replace(",", "."))

def data_br(s):
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None

def analisa(html):
    p = Tabelas(); p.feed(html)
    texto = " ".join(" ".join(p.texto).split())
    return p.tabelas, texto

def data_pagina(texto):
    m = re.search(r"[Ff]echamento[^0-9]{0,20}(\d{2}/\d{2}/\d{4})", texto) or re.search(r"(\d{2}/\d{2}/\d{4})", texto)
    return data_br(m.group(1)) if m else None

def futuros(html):
    tabelas, texto = analisa(html); out = []
    for t in tabelas:
        for r in t:
            m = re.match(r"^\s*(" + "|".join(MESES) + r")\s*/\s*(\d{4})\s*$", r[0], re.I) if r else None
            if m and len(r) >= 2:
                preco = num(r[1]); var = num(r[2]) if len(r) > 2 else 0.0
                if preco: out.append((int(m.group(2)), MESES.index(m.group(1).lower()) + 1, preco, var or 0.0))
        if out: break
    return sorted(out), (data_pagina(texto) or datetime.now(timezone(timedelta(hours=-3))).strftime("%Y-%m-%d"))

def rot(a, m): return f"{ABREV[m-1]}/{str(a)[2:]}"

def boi():
    c, data = futuros(baixar(FONTES["boi"])); hoje = datetime.now(timezone(timedelta(hours=-3)))
    ref = (hoje.year, hoje.month)
    spot = next((p for a, m, p, v in c if (a, m) == ref), None)
    prox = [(a, m, p, v) for a, m, p, v in c if (a, m) > ref][:4]
    if len(prox) < 4 or not all(200 < p < 800 for _, _, p, _ in prox): raise ValueError("boi: contratos insuficientes ou fora da faixa")
    return {"data": data, "spot": spot, "v": [[rot(a, m), p, v] for a, m, p, v in prox]}

def milho():
    c, data = futuros(baixar(FONTES["milho"])); hoje = datetime.now(timezone(timedelta(hours=-3)))
    prox = [(a, m, p, v) for a, m, p, v in c if (a, m) >= (hoje.year, hoje.month)][:4]
    if len(prox) < 4 or not all(20 < p < 200 for _, _, p, _ in prox): raise ValueError("milho: contratos insuficientes ou fora da faixa")
    return {"data": data, "v": [[rot(a, m), p, v] for a, m, p, v in prox]}

def reposicao(chave):
    tabelas, texto = analisa(baixar(FONTES[chave]))
    for t in tabelas:
        for r in t:
            if "MT" in [c.strip() for c in r]:
                i = [c.strip() for c in r].index("MT"); cab = num(r[i + 1]) if len(r) > i + 1 else None
                d = data_br(r[0]) or data_pagina(texto)
                if cab and 1500 < cab < 12000 and d: return cab, d
    raise ValueError(f"reposição {chave}: linha de MT não encontrada")

REPO = [("desmama", "Desmama", "8 meses", 195, 6.5), ("bezerro", "Bezerro", "12 meses", 240, 8), ("garrote", "Garrote", "18 meses", 300, 10), ("magro", "Boi magro", "", 375, 12.5)]
# fêmea Nelore: os pesos de referência da Scot (desmama 180 kg 6@, bezerra 210 kg 7@, novilha 270 kg 9@, vaca boiadeira 330 kg 11@)
REPO_F = [("f_desmama", "Desmama", "8 meses", 180, 6), ("f_bezerra", "Bezerra", "12 meses", 210, 7), ("f_novilha", "Novilha", "18 meses", 270, 9), ("f_vaca", "Vaca boiadeira", "", 330, 11)]

def tabela_reposicao(lista, anterior, erros):
    """Uma linha por categoria; se uma falhar, mantém o valor antigo dela."""
    antigo = {x[0]: x for x in (anterior or [])}
    linhas = []
    for chave, nome, idade, kg, arr in lista:
        try: cab, d = reposicao(chave); linhas.append([nome, idade, kg, arr, cab, d])
        except Exception as e:
            erros.append(f"{chave}: {e}")
            if nome in antigo: linhas.append(antigo[nome])
    return linhas

# Selic: Banco Central (SGS). 432 = meta Selic (% a.a.); 4390 = Selic acumulada no mês (% a.m.).
# O mês corrente fica de fora (ainda incompleto); o app completa com a meta.
SGS = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.{}/dados/ultimos/{}?formato=json"
SGS_PERIODO = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.{}/dados?formato=json&dataInicial={}&dataFinal={}"
def selic():
    meta = float(json.loads(baixar(SGS.format(432, 1)))[-1]["valor"])
    if not 1 <= meta <= 50: raise ValueError(f"meta fora da faixa: {meta}")
    agora = datetime.now(timezone(timedelta(hours=-3)))
    hoje = agora.strftime("%Y-%m")
    mensal = {}
    ini = (agora - timedelta(days=3 * 366)).strftime("01/%m/%Y")
    for x in json.loads(baixar(SGS_PERIODO.format(4390, ini, agora.strftime("%d/%m/%Y")))):
        d, m, a = x["data"].split("/"); k = f"{a}-{m}"; v = float(x["valor"])
        if k < hoje and 0 <= v <= 5: mensal[k] = v
    if len(mensal) < 12: raise ValueError("poucos meses da Selic")
    return {"data": agora.strftime("%Y-%m-%d"), "meta": meta, "mensal": mensal}

# Dólar comercial (venda), Banco Central SGS 1: último valor e variação sobre o dia anterior
def dolar():
    a = json.loads(baixar(SGS.format(1, 2)))
    v, ant = float(a[-1]["valor"]), float(a[-2]["valor"])
    if not 2 <= v <= 15: raise ValueError(f"dólar fora da faixa: {v}")
    d, m, y = a[-1]["data"].split("/")
    return {"data": f"{y}-{m}-{d}", "v": v, "var": round((v / ant - 1) * 100, 2)}

# Relações de troca do dia (guardadas para comparar com a média): sacas de milho por @ do boi gordo,
# bezerros de desmama e bois magros pagos por um boi gordo de 18 @, e ágio da @ da desmama sobre a @ do boi gordo.
BOI_ARROBAS = 18
def trocas(atual):
    spot = float(atual["boi"]["spot"]); milho = float(atual["milho"]["v"][0][1]); rep = atual["reposicao"]["v"]
    desm = next(x for x in rep if x[0] == "Desmama"); magro = next(x for x in rep if x[0] == "Boi magro")
    return [round(spot / milho, 3), round(BOI_ARROBAS * spot / desm[4], 3), round(BOI_ARROBAS * spot / magro[4], 3), round((desm[4] / desm[3] / spot - 1) * 100, 2)]

def main():
    try: atual = json.load(open(SAIDA, encoding="utf-8"))
    except Exception: atual = {}
    erros = []
    for chave, fn in (("boi", boi), ("milho", milho)):
        try: atual[chave] = fn()
        except Exception as e: erros.append(f"{chave}: {e}")
    try: atual["selic"] = selic()
    except Exception as e: erros.append(f"selic: {e}")
    try: atual["dolar"] = dolar()
    except Exception as e: erros.append(f"dolar: {e}")
    for chave_json, lista in (("reposicao", REPO), ("reposicao_femea", REPO_F)):
        linhas = tabela_reposicao(lista, atual.get(chave_json, {}).get("v"), erros)
        if len(linhas) == 4: atual[chave_json] = {"uf": "MT", "v": linhas}
    try:
        hist = atual.get("trocas") or {}
        hist[datetime.now(timezone(timedelta(hours=-3))).strftime("%Y-%m-%d")] = trocas(atual)
        atual["trocas"] = dict(sorted(hist.items())[-400:])
    except Exception as e: erros.append(f"trocas: {e}")
    atual["atualizado"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    json.dump(atual, open(SAIDA, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for e in erros: print("ERRO", e, file=sys.stderr)
    print("ok" if not erros else f"{len(erros)} erro(s)")
    sys.exit(1 if erros else 0)

if __name__ == "__main__": main()
