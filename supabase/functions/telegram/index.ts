// Caderno da Fazenda: robô do Telegram (função "telegram" do Supabase)
// Recebe foto de nota fiscal, texto ou anotação de um sócio, pede ao Claude para ler
// e lança na fazenda dele: custo em "desembolsos" ou anotação no bloco de notas do mês.
// Segredos (Edge Functions → Secrets): TELEGRAM_BOT_TOKEN e ANTHROPIC_API_KEY.
// Verde do pasto (satélite): CDSE_CLIENT_ID e CDSE_CLIENT_SECRET, do Copernicus Data Space.
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY o próprio Supabase fornece.
// Depois de publicar, abra .../functions/v1/telegram?setup=1 uma vez para ligar o webhook.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";
import { zipSync } from "npm:fflate@0.8.2";

/* ---------- tipos de custo: os mesmos do app (chave, nome, grupo do benchmark) ---------- */
const ITENS: [string, string, string][] = [
  ["peao", "Peão / funcionário fixo", "mao"], ["empreiteiro", "Empreiteiro", "mao"], ["diarista", "Diarista", "mao"],
  ["combustivel", "Combustível", "maquinas"], ["medicacao", "Medicamentos e vacinas", "sanidade"],
  ["suplementacao", "Suplementação e ração", "nutricao"], ["sal", "Sal mineral", "nutricao"],
  ["reproducao", "Sêmen e protocolos de IATF", "reproducao"], ["pasto", "Adubo, semente e reforma de pasto", "pastagem"],
  ["arrendamento", "Arrendamento", "arrendamento"], ["cercas", "Cercas, curral e benfeitorias", "manutencao"],
  ["maquinas", "Manutenção de máquinas e veículos", "maquinas"], ["energia", "Energia elétrica", "administracao"],
  ["admin", "Contador e escritório", "administracao"], ["internet", "Internet (Starlink)", "administracao"], ["mercado", "Mercado (alimentação)", "mao"], ["impostos", "Impostos e taxas", "impostos"],
  ["frete", "Frete e comissões", "outros"], ["outros", "Outros gastos", "outros"],
];
const ITN = Object.fromEntries(ITENS.map((i) => [i[0], i[1]]));
const ITG = Object.fromEntries(ITENS.map((i) => [i[0], i[2]]));
const ONDE: Record<string, string> = { geral: "Fazenda toda", cria: "Cria", recria: "Recria", engorda: "Engorda" };
/* rebanho: as mesmas categorias e tipos de movimento do app */
const CATS: Record<string, string> = { matrizes: "Matrizes", descarte: "Matrizes de descarte", bezerros: "Bezerros mamando", touros: "Touros",
  f8_12: "Fêmeas 8 a 12 meses", f13_24: "Fêmeas 13 a 24 meses", f24: "Fêmeas > 24 meses",
  m8_12: "Machos 8 a 12 meses", m13_24: "Machos 13 a 24 meses", m25_36: "Machos 25 a 36 meses", m36: "Machos > 36 meses", outras: "Outras categorias",
  // gado P.O. (puro de origem), separado do comercial
  po_vaca_cria: "P.O. Vaca com cria", po_vaca_solteira: "P.O. Vaca solteira", po_vaca_prenha: "P.O. Vaca prenha", po_touro: "P.O. Touro",
  po_bezerro: "P.O. Bezerro", po_bezerra: "P.O. Bezerra", po_novilha: "P.O. Novilha", po_garrote: "P.O. Garrote" };
const NASC = ["bezerros", "po_bezerro", "po_bezerra"];
const TIPOS_MOV: Record<string, string> = { nascimento: "Nascimento", compra: "Compra", venda: "Venda", morte: "Morte", transferencia: "Mudança de categoria" };
const MESF = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/* ---------- utilidades ---------- */
const hojeMT = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Cuiaba" }).format(new Date()); // AAAA-MM-DD
const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dBR = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const okData = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
async function segredoWebhook(token: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("caderno:" + token));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

/* ---------- o que o Claude devolve ---------- */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tipo", "custos", "movimentos", "anotacao", "lembretes", "alertas", "pesagens", "contas", "pagou", "areas", "resposta"],
  properties: {
    tipo: { type: "string", enum: ["lancamento", "pergunta", "nao_entendi"] },
    custos: {
      type: "array", description: "um item por gasto; vazio se não houver",
      items: {
        type: "object", additionalProperties: false,
        required: ["data", "valor", "item", "onde", "descricao", "retiro", "rebanho"],
        properties: {
          retiro: { type: "string", description: "nome do retiro se a mensagem disser que este item é de um retiro (ex.: 'despesa Santa Helena ...'); vazio = Sede (fazenda principal), também quando citar a Sede" },
          data: { type: "string", description: "AAAA-MM-DD da compra; se disser só o mês a que o gasto se refere ('diárias de outubro', 'referente a outubro'), o último dia desse mês; vazio se não aparecer" },
          valor: { type: "number", description: "valor pago em reais" },
          item: { type: "string", enum: ITENS.map((i) => i[0]) },
          onde: { type: "string", enum: Object.keys(ONDE) },
          descricao: { type: "string", description: "curta: o que foi comprado e de quem, ex.: 'Diesel S10 300 L · Posto Trevo'" },
          rebanho: { type: "string", enum: ["", "com", "po"], description: "po = gasto só do gado P.O.; com = só do gado comercial; vazio = dos dois (o normal)" },
        },
      },
    },
    anotacao: { type: "string", description: "o que é para lembrar e não é gasto nem movimento de animais; vazio se não houver" },
    movimentos: {
      type: "array", description: "um item por movimento de animais; vazio se não houver",
      items: {
        type: "object", additionalProperties: false,
        required: ["mov", "data", "categoria", "para", "cab", "peso_medio", "preco_arroba", "valor", "obs", "retiro"],
        properties: {
          retiro: { type: "string", description: "nome do retiro se a mensagem disser que este item é de um retiro (ex.: 'despesa Santa Helena ...'); vazio = Sede (fazenda principal), também quando citar a Sede" },
          mov: { type: "string", enum: Object.keys(TIPOS_MOV) },
          data: { type: "string", description: "AAAA-MM-DD; vazio se a mensagem não disser (usa hoje)" },
          categoria: { type: "string", enum: Object.keys(CATS), description: "categoria dos animais (na mudança de categoria: a de origem)" },
          para: { type: "string", enum: ["", ...Object.keys(CATS)], description: "só na mudança de categoria: a de destino; senão vazio" },
          cab: { type: "integer", description: "número de cabeças" },
          peso_medio: { type: "number", description: "kg vivo por cabeça; 0 se não disser" },
          preco_arroba: { type: "number", description: "só na venda: R$ por arroba; 0 se não disser" },
          valor: { type: "number", description: "compra: total pago; venda: total recebido; 0 se não disser ou nos outros tipos" },
          obs: { type: "string", description: "curta: sexo dos bezerros, causa da morte, comprador, vendedor… vazio se nada" },
        },
      },
    },
    lembretes: {
      type: "array", description: "pedidos para o robô avisar num dia; vazio se não houver",
      items: {
        type: "object", additionalProperties: false, required: ["data", "texto"],
        properties: {
          data: { type: "string", description: "AAAA-MM-DD do dia em que é para avisar" },
          texto: { type: "string", description: "curto: do que lembrar, ex.: 'vacina da aftosa' ou 'pagar boleto do sal'" },
        },
      },
    },
    alertas: {
      type: "array", description: "pedidos de aviso do preço da arroba do boi gordo; vazio se não houver",
      items: {
        type: "object", additionalProperties: false, required: ["direcao", "valor"],
        properties: {
          direcao: { type: "string", enum: ["acima", "abaixo"] },
          valor: { type: "number", description: "R$ por arroba" },
        },
      },
    },
    pesagens: {
      type: "array", description: "pesagens de animais; vazio se não houver",
      items: {
        type: "object", additionalProperties: false, required: ["data", "lote", "cab", "peso_medio", "retiro"],
        properties: {
          retiro: { type: "string", description: "nome do retiro se a mensagem disser que este item é de um retiro (ex.: 'despesa Santa Helena ...'); vazio = Sede (fazenda principal), também quando citar a Sede" },
          data: { type: "string", description: "AAAA-MM-DD; vazio se a mensagem não disser (usa hoje)" },
          lote: { type: "string", description: "nome do lote como o pecuarista chama, em minúsculas (ex.: recria, engorda, lote 3, garrotes da baixada)" },
          cab: { type: "integer", description: "cabeças pesadas; 0 se não disser" },
          peso_medio: { type: "number", description: "kg vivo médio por cabeça" },
        },
      },
    },
    contas: {
      type: "array", description: "contas a pagar que ainda NÃO foram pagas (boleto, parcela, fatura com vencimento); vazio se não houver",
      items: {
        type: "object", additionalProperties: false, required: ["descricao", "valor", "vencimento", "item", "onde", "retiro", "mensal"],
        properties: {
          mensal: { type: "boolean", description: "true se a conta se repete todo mês (Starlink, salário, aluguel, 'todo dia 16', 'custo fixo por mês')" },
          descricao: { type: "string", description: "curta: o que é e de quem, ex.: 'Boleto sal mineral · Agropecuária X'" },
          valor: { type: "number", description: "valor em reais" },
          vencimento: { type: "string", description: "AAAA-MM-DD; se só disser o dia, é o próximo dia com esse número a partir de hoje" },
          item: { type: "string", enum: ITENS.map((i) => i[0]) },
          onde: { type: "string", enum: Object.keys(ONDE) },
          retiro: { type: "string", description: "nome do retiro se a mensagem disser; vazio = Sede" },
        },
      },
    },
    areas: {
      type: "array", description: "mudança do tamanho da área produtiva (ha) de uma parte da fazenda; vazio se não houver",
      items: {
        type: "object", additionalProperties: false, required: ["parte", "fase", "ha"],
        properties: {
          parte: { type: "string", description: "nome do retiro, 'Sede' ou 'fazenda toda'" },
          fase: { type: "string", enum: ["", "cria", "recria", "engorda"], description: "vazio = área produtiva total da parte; cria/recria/engorda = só a área dessa fase" },
          ha: { type: "number", description: "hectares" },
        },
      },
    },
    pagou: { type: "array", items: { type: "integer" }, description: "números das contas da lista 'Contas a pagar marcadas' que a mensagem diz que foram pagas; vazio se nenhuma" },
    resposta: { type: "string", description: "quando tipo = nao_entendi: uma frase curta pedindo o que falta" },
  },
};
const SISTEMA = `Você lê o que um pecuarista manda pelo Telegram para o caderno da fazenda dele (cria, recria e engorda de gado de corte, em Mato Grosso).
Uma mensagem pode trazer várias coisas ao mesmo tempo (ex.: "gastei 300 de sal e 200 de diesel, nasceram 5 bezerros, morreu 1 vaca e choveu 30 mm"). Separe cada uma no lugar certo; nada pode ficar de fora nem ser lançado duas vezes.
tipo:
- "lancamento": a mensagem lança alguma coisa. Preencha o que houver em custos, movimentos, anotacao, lembretes, alertas, pesagens e areas (o que não houver fica vazio).
- "pergunta": quer saber algo dos dados da fazenda e não está lançando nada (ex.: "quantas vacas eu tenho", "quanto gastei de sal em outubro", "quantos bezerros nasceram esse ano"). Tudo o mais fica vazio; a resposta vem depois.
- "nao_entendi": não dá para saber o que lançar. Em "resposta", peça em uma frase o que falta.
custos: cada gasto pago (nota fiscal, cupom, recibo, boleto pago, "gastei", "paguei"). Um item por gasto citado; numa foto de nota, um item com o valor TOTAL e o tipo que descreve a maior parte. data da nota (vazio se não houver; se a mensagem disser a que mês o gasto se refere, como "28 diárias em outubro" ou "o sal de setembro", use o último dia desse mês, ou hoje se for o mês atual; mês sem ano é o mais recente que já passou ou o atual), valor em reais, tipo de custo (item) e descrição curta. Gasto sem valor não entra: peça o valor em "resposta" e lance o resto.
  rebanho do gasto: "po" só quando a mensagem disser que o gasto é do gado P.O./PO (ex.: "sêmen para as vacas PO", "ração do P.O."); "com" só quando disser que é só do comercial; senão vazio (é dos dois).
movimentos: nascimento, compra, venda, morte ou mudança de categoria de animais (ex.: "nasceram 5 bezerros machos", "morreu 1 vaca de picada de cobra", "vendi 20 bois de 540 kg a 310 a arroba", "comprei 30 garrotes por 90 mil", "desmamei 40 bezerros machos para a recria"). Um item por movimento. Compra ou venda de animais vai só aqui, com o valor no movimento, nunca também em custos.
  Categorias: ${Object.entries(CATS).map(([k, v]) => `${k} = ${v}`).join("; ")}.
  Nascimento do gado comercial é sempre "bezerros" (anote o sexo em obs). Vaca/matriz = matrizes; vaca de descarte/vaca gorda para abate = descarte; desmama/bezerro desmamado macho = m8_12, fêmea = f8_12; garrote ou novilho de 1 a 2 anos = m13_24; boi magro de 2 a 3 anos = m25_36; boi gordo/boi acima de 3 anos = m36; novilha de 1 a 2 anos = f13_24; novilha acima de 2 anos = f24. Se só disser "boi" sem idade, use m25_36 em compra e m36 em venda. Desmame = mudança de categoria de bezerros para m8_12 ou f8_12 (machos e fêmeas em itens separados).
  Gado P.O. (puro de origem, "PO", registrado, elite) tem categorias próprias, com "po_" na frente; use-as SÓ quando a mensagem disser P.O./PO, senão é gado comercial. Vaca P.O. com bezerro ao pé/parida = po_vaca_cria; vaca P.O. vazia/solteira = po_vaca_solteira; vaca P.O. prenha/prenhe = po_vaca_prenha (se não disser qual, use po_vaca_solteira e avise em "resposta"); bezerro P.O. macho = po_bezerro; bezerra P.O. = po_bezerra; novilha P.O. = po_novilha; garrote/tourinho P.O. = po_garrote; touro P.O./reprodutor P.O. = po_touro. Nascimento P.O.: macho = po_bezerro, fêmea = po_bezerra (sem dizer o sexo, po_bezerro e anote em obs). Desmame P.O. = mudança de po_bezerro para po_garrote ou de po_bezerra para po_novilha. Vaca P.O. que pariu, emprenhou ou desmamou = mudança entre po_vaca_prenha, po_vaca_cria e po_vaca_solteira.
anotacao: o que é para lembrar e não é gasto nem movimento (chuva, vacinação feita, observação do pasto, "anotar: ..."), escrito de forma curta, sem o "anotar:". Várias observações vão juntas no mesmo texto, separadas por "; ".
lembretes: pedidos para o robô avisar num dia ("lembrar: vacina da aftosa dia 15/11", "me lembra de pagar o boleto do sal dia 20", "boleto do sal vence dia 20"). data = o dia citado; se só disser o número do dia, é o próximo dia com esse número a partir de hoje; "amanhã" = hoje + 1. Lembrete sem dia não entra: peça o dia em "resposta". O que vai para lembretes não vai também para anotacao.
alertas: pedidos de aviso do preço da arroba do boi gordo ("me avisa quando o boi passar de 320" = acima 320; "quando a arroba cair abaixo de 300" = abaixo 300).
pesagens: pesagem de animais ("pesei o lote da recria, média 280 kg", "pesei 40 garrotes do lote 3, deu 312 kg"). Um item por lote pesado, com o peso médio por cabeça (se disser o peso total e as cabeças, divida). Pesagem não é movimento nem anotação.
contas: boleto, parcela ou fatura que ainda vai ser paga, com vencimento ("boleto do sal 4.500 vence dia 20", "parcela do trator 3.200 vence 10/12"). Não vai para custos: o custo entra quando pagar. Sem valor ou sem vencimento, não entra: peça em "resposta". Conta que se repete todo mês ("Starlink 180 todo dia 16", "custo fixo de 180 por mês, vence dia 10", "salário do peão 2.500 todo dia 5") = mensal true, com o vencimento no próximo dia citado; o robô marca o mês seguinte sozinho quando ela for paga. Custo fixo mensal vai para contas, nunca para anotacao; sem o dia do mês, peça o dia em "resposta".
areas: quando a mensagem disser o tamanho da área de produção (área produtiva, área de pasto) de uma parte da fazenda ("área de produção: Sede 270 ha; Santa Helena 68 ha", "a recria da Santa Faustina tem 30 hectares", "a fazenda toda tem 406 ha"). Um item por parte (e por fase, se disser a fase). Alqueire: converta para ha (1 alqueire = 4,84 ha, o alqueire goiano, salvo se disser paulista = 2,42 ha). Área NÃO vai também para anotacao.
pagou: quando a mensagem disser que pagou uma conta da lista "Contas a pagar marcadas" (que vem junto), ponha o número dela e NÃO lance esse pagamento também em custos. Pagamento que não está na lista vai para custos, como sempre.
resposta: vazio quando deu para lançar tudo; se alguma parte ficou de fora por falta de informação, diga em uma frase o que faltou.
Tipos de custo (item): ${ITENS.map((i) => `${i[0]} = ${i[1]}`).join("; ")}.
Dicas: diesel/gasolina/óleo = combustivel; vacina, vermífugo, antibiótico = medicacao; ração, DDG, milho, núcleo, proteinado = suplementacao; sal mineral = sal; peça, pneu, conserto de trator/caminhonete = maquinas; arame, mourão, conserto de curral = cercas; salário de funcionário fixo = peao; mercado, supermercado, rancho, compra de comida e mantimentos = mercado; Starlink, internet, mensalidade da antena = internet; contador, material de escritório = admin; diária = diarista.
"onde": cria, recria ou engorda só se a mensagem disser claramente o setor; senão "geral" (fazenda toda).
retiro (em cada custo, movimento e pesagem): a fazenda é dividida em retiros (os nomes vêm junto da mensagem), cada um com seu gado e suas contas. Quem manda avisa antes de qual retiro é ("despesa Santa Helena: ...", "Santa Faustina: nasceram 3 bezerros"). O retiro citado vale para os itens que vêm depois dele, até citar outro. Item sem retiro citado, ou da Sede, fica vazio: é da Sede (a fazenda principal). "Fazenda toda" é a soma dos retiros com a Sede.
Responda só com o JSON pedido.`;

export type Mov = { retiro?: string; mov: string; data: string; categoria: string; para: string; cab: number; peso_medio: number; preco_arroba: number; valor: number; obs: string };
export type Custo = { retiro?: string; data: string; valor: number; item: string; onde: string; descricao: string; rebanho?: string };
const REB: Record<string, string> = { com: "comercial", po: "P.O." };
export type Lembrete = { data: string; texto: string };
export type Alerta = { direcao: string; valor: number };
export type Pesagem = { retiro?: string; data: string; lote: string; cab: number; peso_medio: number };
export type Area = { parte: string; fase: string; ha: number };
export type Leitura = { tipo: string; custos?: Custo[]; movimentos?: Mov[]; anotacao?: string; lembretes?: Lembrete[]; alertas?: Alerta[]; pesagens?: Pesagem[]; contas?: any[]; pagou?: number[]; areas?: Area[]; resposta?: string };

/* ---------- dependências (trocadas por imitações nos testes) ---------- */
export type Deps = {
  token: string;
  tg: (metodo: string, corpo: Record<string, unknown>) => Promise<any>;
  baixa: (caminho: string) => Promise<Uint8Array>;
  le: (conteudo: any[]) => Promise<Leitura | null>;
  pensa: (sistema: string, texto: string) => Promise<string | null>; // responde perguntas com os dados
  guarda?: (caminho: string, bytes: Uint8Array, tipo: string) => Promise<boolean>; // foto da nota no Storage (pasta "notas")
  link?: (caminho: string) => Promise<string | null>; // link temporário para ver a foto
  usuario?: (token: string) => Promise<string | null>; // id de quem está logado no app
  transcreve?: (bytes: Uint8Array, nome: string) => Promise<string | null>; // áudio → texto (OpenAI); ausente se não houver a chave
  envia?: (chat: number, nome: string, bytes: Uint8Array, legenda: string, tipo?: string) => Promise<any>; // manda um arquivo (backup, planilha)
  planilha?: (abas: Aba[]) => Uint8Array; // monta o arquivo Excel
  baixaNota?: (caminho: string) => Promise<Uint8Array | null>; // foto da nota guardada no Storage
  zip?: (arquivos: Record<string, Uint8Array>) => Uint8Array; // junta as fotos num .zip
  cotacao?: () => Promise<{ data: string; spot: number } | null>; // arroba do boi gordo (cotacoes.json do app)
  db: any; // cliente supabase com a chave de serviço
  admin?: { // contas do login (chave de administrador; só a função usa)
    ver: (id: string) => Promise<any | null>;
    criar: (email: string, senha: string, meta: Record<string, unknown>) => Promise<{ id?: string; erro?: string }>;
    atualizar: (id: string, attrs: Record<string, unknown>) => Promise<boolean>;
  };
  origem?: string; // de onde veio o lançamento ("telegram" ou "app", pelo microfone do app)
  focos?: () => Promise<{ lat: number; lng: number; sat: string; t: number }[]>; // focos de calor recentes (INPE)
  chuva?: (lat: number, lng: number, de: string, ate: string) => Promise<{ d: string; mm: number | null }[]>; // chuva diária estimada (Open-Meteo)
  verde?: { // satélite Sentinel-2 (Copernicus); sem as chaves, fica de fora
    serie: (poly: number[][], de: string, ate: string) => Promise<{ d: string; m: number; v: number; bons?: number; total?: number }[]>;
    imagem: (poly: number[][], de: string, ate: string) => Promise<string>; // PNG em base64
  };
};

/* ---------- respostas ---------- */
const responde = (d: Deps, chat: number, texto: string, extra: Record<string, unknown> = {}) =>
  d.tg("sendMessage", { chat_id: chat, text: texto, parse_mode: "HTML", ...extra });
const esc = (s: string) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
/* ---------- retiros: cada um tem o seu gado e as suas contas (config.dados.retiros; os mesmos padrões do app) ---------- */
export type Retiro = { id: string; nome: string; donos?: string[] };
const RET_PADRAO: Retiro[] = [{ id: "sh", nome: "Santa Helena", donos: [] }, { id: "sf", nome: "Santa Faustina", donos: [] }];
export const retirosDe = (D: any): Retiro[] => (Array.isArray(D?.retiros) ? D.retiros : RET_PADRAO);
const semAcento = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
// retiro citado na mensagem; sem citar nada (ou citando a Sede), "" = Sede, a fazenda principal
export function qualRetiro(rets: Retiro[], citado: string) {
  const c = semAcento(citado).replace(/^retiro\s+/, "");
  if (!c) return "";
  return (rets.find((r) => semAcento(r.nome) === c || semAcento(r.nome).includes(c) || c.includes(semAcento(r.nome))) || {} as Retiro).id || "";
}
export const GERAL = "Sede"; // lançamentos sem retiro são da Sede; fazenda toda = retiros + Sede
const nomeRet = (rets: Retiro[], id: string) => (id && rets.find((r) => r.id === id)?.nome) || GERAL;
// etiqueta no fim da linha de cada item ("· 🏠 Santa Helena"); o botão de retiro troca todas
const tagRet = (rets: Retiro[], id: string) => (rets.length ? ` · 🏠 ${esc(nomeRet(rets, id))}` : "");
// botões: trocar o setor (só quando a mensagem lançou um custo só), trocar o retiro e desfazer tudo o que a mensagem lançou
const botoes = (base: string, custoId = "", onde = "", rets: Retiro[] = [], ret = "") => ({
  reply_markup: { inline_keyboard: [
    ...(custoId ? [Object.keys(ONDE).map((k) => ({ text: (k === onde ? "• " : "") + ONDE[k], callback_data: `onde:${custoId}:${k}` }))] : []),
    ...(rets.length ? [[...rets.map((r) => ({ text: (r.id === ret ? "• " : "") + r.nome, callback_data: `ret:${base}:${r.id}` })),
      { text: (ret === "" ? "• " : "") + GERAL, callback_data: `ret:${base}:geral` }]] : []),
    [{ text: "↩ Desfazer", callback_data: `desf:${base}` }],
  ] },
});
const AJUDA = "Mande a <b>foto da nota</b> ou escreva. Pode juntar várias coisas numa mensagem só (sai mais barato), por exemplo: <i>gastei 300 de sal e 200 de diesel, nasceram 5 bezerros e choveu 30 mm</i>\n\nTambém pode mandar <b>áudio</b> 🎤 falando a mesma coisa.\n\nOutros exemplos:\n• <i>gastei 300 de vacina na recria</i>\n• <i>nasceram 5 bezerros machos</i>\n• <i>morreu 1 vaca de picada de cobra</i>\n• <i>vendi 20 bois de 540 kg a 310 a arroba</i>\n• <i>anotar: choveu 40 mm hoje</i>\n• <i>pesei o lote da recria, 40 cabeças, média 280 kg</i>\nEu lanço no Caderno da Fazenda com o seu nome.\n\n🏠 <b>Retiros:</b> diga antes de qual é: <i>despesa Santa Helena: 300 de sal</i> · <i>Santa Faustina: nasceram 3 bezerros</i>. Sem dizer, fica para a <b>Sede</b>. Qualquer sócio lança em qualquer um. Para perguntar de uma parte: <i>dados Santa Faustina: quanto gastei em outubro?</i> Sem dizer a parte, a resposta é da <b>fazenda toda</b> (Santa Helena + Santa Faustina + Sede).\n\n🧾 <b>Contas a pagar:</b> <i>boleto do sal 4.500 vence dia 20</i>. Aviso na véspera e no dia, com o botão Paguei. Mande <b>contas</b> para ver todas.\n📎 Para o contador: <b>planilha</b> (do mês), <b>notas</b> (fotos das notas do mês), <b>planilha do ano</b> (Imposto de Renda).\n\n⏰ <b>Lembretes:</b> <i>lembrar: vacina da aftosa dia 15/11</i> (aviso às 7h do dia)\n📈 <b>Arroba:</b> <i>me avisa quando o boi passar de 320</i>\nPara ver ou cancelar, mande <b>lembretes</b>. Para receber a cópia dos dados agora, mande <b>backup</b> (ela também chega toda segunda). Todo dia 1º chega o relatório do mês e a planilha para o contador; para receber agora, mande <b>relatório</b> ou <b>planilha</b> (ou <i>planilha de outubro</i>).\n\nTambém respondo perguntas: <i>quantas vacas eu tenho?</i> · <i>quanto gastei de sal em outubro?</i>";

/* ---------- ligar o Telegram a uma conta ---------- */
async function liga(d: Deps, chat: number, codigo: string, nome: string) {
  const { data: c } = await d.db.from("telegram_codigos").select("user_id,fazenda_id,expira").eq("codigo", codigo).maybeSingle();
  if (!c || new Date(c.expira) < new Date()) return responde(d, chat, "Código inválido ou vencido. No app, vá em <b>Mais → Sócios → Conectar meu Telegram</b> e use o código novo.");
  await d.db.from("telegram_contas").upsert({ chat_id: chat, user_id: c.user_id, fazenda_id: c.fazenda_id, nome_telegram: nome }, { onConflict: "chat_id" });
  await d.db.from("telegram_codigos").delete().eq("codigo", codigo);
  const { data: m } = await d.db.from("membros").select("nome,email").eq("fazenda_id", c.fazenda_id).eq("user_id", c.user_id).maybeSingle();
  return responde(d, chat, `Pronto, ${esc(m?.nome || nome)}! Seu Telegram está ligado ao Caderno da Fazenda.\n\n${AJUDA}`);
}

/* ---------- foto da nota (comprovante) ---------- */
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };
async function guardaNota(d: Deps, fazenda: string, bytes: Uint8Array, tipo: string) {
  if (!d.guarda || !EXT[tipo]) return "";
  const caminho = `${fazenda}/${hojeMT().slice(0, 7)}/${crypto.randomUUID()}.${EXT[tipo]}`;
  return (await d.guarda(caminho, bytes, tipo)) ? caminho : "";
}
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s); };

/* ---------- app: ler / ver a foto da nota (POST ?nota=ler ou ?nota=ver, com o login do app) ---------- */
export async function notaApp(d: Deps, acao: string, token: string, corpo: any): Promise<{ status: number; json: any }> {
  const uid = token && d.usuario ? await d.usuario(token) : null;
  if (!uid) return { status: 401, json: { erro: "Entre de novo no app." } };
  const fazenda = String(corpo?.fazenda || "");
  const { data: m } = await d.db.from("membros").select("user_id").eq("fazenda_id", fazenda).eq("user_id", uid).maybeSingle();
  if (!m) return { status: 403, json: { erro: "Você não é sócio desta fazenda." } };
  if (acao === "ver") {
    const caminho = String(corpo?.caminho || "");
    if (!caminho.startsWith(fazenda + "/") || caminho.includes("..")) return { status: 400, json: { erro: "Nota inválida." } };
    const url = d.link ? await d.link(caminho) : null;
    return url ? { status: 200, json: { url } } : { status: 404, json: { erro: "Não achei a foto." } };
  }
  if (acao !== "ler") return { status: 400, json: { erro: "?" } };
  const tipo = String(corpo?.tipo || "image/jpeg"), dados = String(corpo?.imagem || "");
  if (!EXT[tipo] || !dados || dados.length > 12_000_000) return { status: 400, json: { erro: "Foto inválida ou grande demais." } };
  const bytes = Uint8Array.from(atob(dados), (c) => c.charCodeAt(0));
  const caminho = await guardaNota(d, fazenda, bytes, tipo);
  if (!corpo?.ler) return caminho ? { status: 200, json: { caminho } } : { status: 500, json: { erro: "Não consegui guardar a foto." } };
  const L = await d.le([
    tipo === "application/pdf" ? { type: "document", source: { type: "base64", media_type: tipo, data: dados } }
      : { type: "image", source: { type: "base64", media_type: tipo, data: dados } },
    { type: "text", text: `Hoje é ${hojeMT()}.\n(foto de nota tirada no app: é um custo)` },
  ]);
  const C = (L?.custos || []).filter((c) => Number(c.valor) > 0), c0 = C[0];
  const leitura = c0 ? {
    data: okData(c0.data) && c0.data <= hojeMT() ? c0.data : "", valor: Math.round(C.reduce((a, c) => a + Number(c.valor), 0) * 100) / 100,
    item: ITN[c0.item] ? c0.item : "outros", onde: ONDE[c0.onde] ? c0.onde : "geral", descricao: C.map((c) => c.descricao).filter(Boolean).join(" · "),
  } : null;
  return { status: 200, json: { caminho, leitura, aviso: leitura ? "" : (L?.resposta || "Não consegui ler a nota. Preencha à mão.") } };
}

/* ---------- app: microfone (POST ?voz=texto ou ?voz=botao, com o login do app) ----------
   O app transforma a fala em texto (de graça, no próprio celular) e manda aqui. O texto segue o mesmo caminho
   de uma mensagem do Telegram; as respostas, em vez de irem para o Telegram, voltam para o app com os botões. */
export async function vozApp(d: Deps, acao: string, token: string, corpo: any): Promise<{ status: number; json: any }> {
  const uid = token && d.usuario ? await d.usuario(token) : null;
  if (!uid) return { status: 401, json: { erro: "Entre de novo no app." } };
  const fazenda = String(corpo?.fazenda || "");
  const { data: m } = await d.db.from("membros").select("nome,email").eq("fazenda_id", fazenda).eq("user_id", uid).maybeSingle();
  if (!m) return { status: 403, json: { erro: "Você não é sócio desta fazenda." } };
  const conta = { user_id: uid, fazenda_id: fazenda }, quem = m.nome || String(m.email || "").split("@")[0] || "sócio";
  const saidas: any[] = [];
  let aviso = "";
  const dv: Deps = { ...d, origem: "app", envia: undefined, planilha: undefined, zip: undefined,
    tg: async (metodo: string, c: Record<string, any>) => {
      if (metodo === "sendMessage" || metodo === "editMessageText")
        saidas.push({ texto: String(c.text || ""), html: c.parse_mode === "HTML", botoes: c.reply_markup?.inline_keyboard || [] });
      if (metodo === "answerCallbackQuery") aviso = String(c.text || "");
      return { ok: true, result: { message_id: 1 } };
    } };
  if (acao === "botao") {
    const data = String(corpo?.data || "");
    if (!/^(desf|ret|onde|pago|canc):/.test(data)) return { status: 400, json: { erro: "Botão inválido." } };
    await botao(dv, { id: "app", data, message: { chat: { id: 0 }, message_id: 1, text: String(corpo?.texto || "").slice(0, 8000),
      reply_markup: { inline_keyboard: Array.isArray(corpo?.botoes) ? corpo.botoes : [] } } }, conta);
    return { status: 200, json: { saidas, aviso } };
  }
  if (acao !== "texto" && acao !== "audio") return { status: 400, json: { erro: "?" } };
  let texto = String(corpo?.texto || "").trim().slice(0, 2000), ouvido = "";
  // áudio gravado no app (normalmente sem internet, enviado quando o sinal voltou): vira texto pela OpenAI, igual ao áudio do Telegram
  if (acao === "audio") {
    const sem = (t: string) => ({ status: 200, json: { ouvido: "", saidas: [{ texto: t, html: false, botoes: [] }] } });
    if (!d.transcreve) return sem("Ainda não entendo áudio: falta ligar a transcrição (chave da OpenAI). Escreva a mensagem.");
    const dados = String(corpo?.audio || ""), tipo = String(corpo?.tipo || "");
    if (!dados || dados.length > 8_000_000) return { status: 400, json: { erro: "Áudio vazio ou grande demais (até 3 minutos)." } };
    const ext = /mp4|m4a|aac/.test(tipo) ? "mp4" : /ogg/.test(tipo) ? "ogg" : /wav/.test(tipo) ? "wav" : "webm";
    const r = await d.transcreve(Uint8Array.from(atob(dados), (c) => c.charCodeAt(0)), `audio.${ext}`);
    if (r == null) return { status: 503, json: { erro: "Não consegui ouvir o áudio agora. Tento de novo daqui a pouco." } };
    ouvido = texto = r.trim().slice(0, 2000);
    if (!texto) return sem("Não consegui entender o áudio. Grave de novo falando mais perto do celular, ou escreva.");
  }
  if (!texto) return { status: 400, json: { erro: "Não ouvi nada. Toque no microfone e fale de novo." } };
  const cmd = texto.toLowerCase().replace(/[.!?]+$/, "").trim();
  if (cmd.length < 60 && /\b(planilha|backup|relat[oó]rio|imposto de renda)\b|^(manda as |mandar as |quero as )?(fotos d[aeo]s? )?notas( fiscais)?$/.test(cmd))
    return { status: 200, json: { saidas: [{ texto: "Planilha, fotos das notas, backup e relatório chegam como arquivo pelo <b>Telegram</b>. Peça lá para o robô.", html: true, botoes: [] }], ouvido } };
  await trataTexto(dv, 0, conta, quem, texto, {}, true);
  return { status: 200, json: { saidas, ouvido } };
}

/* ---------- app: painel de acessos (POST ?acesso=listar|criar|senha|bloquear|desbloquear, com o login do app) ----------
   Só o dono da fazenda (quem a criou) usa. Cria a conta já confirmada, sem e-mail, com senha provisória:
   no primeiro acesso o app pede para a pessoa criar a senha dela (user_metadata.trocar_senha). */
export async function acessoApp(d: Deps, acao: string, token: string, corpo: any): Promise<{ status: number; json: any }> {
  const uid = token && d.usuario ? await d.usuario(token) : null;
  if (!uid) return { status: 401, json: { erro: "Entre de novo no app." } };
  const fazenda = String(corpo?.fazenda || "");
  const { data: fz } = await d.db.from("fazendas").select("criada_por").eq("id", fazenda).maybeSingle();
  if (!fz || fz.criada_por !== uid) return { status: 403, json: { erro: "Só o dono da fazenda gerencia os acessos." } };
  if (!d.admin) return { status: 500, json: { erro: "Painel de acessos não está ligado." } };
  const { data: mem } = await d.db.from("membros").select("user_id,email,nome,created_at").eq("fazenda_id", fazenda);
  const membro = (id: string) => (mem || []).find((m: any) => m.user_id === id);
  const senhaOk = (s: any) => typeof s === "string" && s.length >= 6 && s.length <= 72;
  if (acao === "listar") {
    const acessos = [];
    for (const m of mem || []) {
      const u = await d.admin.ver(m.user_id);
      acessos.push({ user_id: m.user_id, email: m.email || u?.email || "", nome: m.nome || u?.user_metadata?.nome || "", dono: m.user_id === uid,
        ultimo: u?.last_sign_in_at || null, bloqueado: !!u?.banned_until && new Date(u.banned_until) > new Date(), trocar: !!u?.user_metadata?.trocar_senha });
    }
    return { status: 200, json: { acessos } };
  }
  if (acao === "criar") {
    const email = String(corpo?.email || "").trim().toLowerCase(), nome = String(corpo?.nome || "").trim().slice(0, 60), senha = corpo?.senha;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { status: 400, json: { erro: "Digite um e-mail válido." } };
    if (!senhaOk(senha)) return { status: 400, json: { erro: "A senha provisória precisa ter pelo menos 6 letras ou números." } };
    if ((mem || []).some((m: any) => String(m.email || "").toLowerCase() === email)) return { status: 400, json: { erro: "Essa pessoa já é sócia da fazenda." } };
    const r = await d.admin.criar(email, senha, { nome, trocar_senha: true });
    if (!r.id) return { status: 400, json: { erro: /already|registered|exists/i.test(r.erro || "")
      ? "Esse e-mail já tem conta no app. Use o Convidar (mais acima) e peça para ele entrar com a senha dele."
      : "Não consegui criar a conta: " + (r.erro || "erro desconhecido") } };
    const { error } = await d.db.from("membros").insert({ fazenda_id: fazenda, user_id: r.id, email, nome: nome || null, via_convite: true });
    if (error) { console.error("membros", error); return { status: 500, json: { erro: "A conta foi criada, mas não consegui ligar à fazenda. Tente de novo." } }; }
    await d.db.from("convites").delete().eq("fazenda_id", fazenda).eq("email", email);
    return { status: 200, json: { ok: true, user_id: r.id } };
  }
  const alvo = String(corpo?.user_id || "");
  if (!membro(alvo)) return { status: 404, json: { erro: "Essa pessoa não é sócia desta fazenda." } };
  if (acao === "senha") {
    if (!senhaOk(corpo?.senha)) return { status: 400, json: { erro: "A senha precisa ter pelo menos 6 letras ou números." } };
    const ok = await d.admin.atualizar(alvo, { password: corpo.senha, user_metadata: { trocar_senha: alvo !== uid } });
    return ok ? { status: 200, json: { ok: true } } : { status: 500, json: { erro: "Não consegui trocar a senha. Tente de novo." } };
  }
  if (acao === "bloquear" || acao === "desbloquear") {
    if (alvo === uid) return { status: 400, json: { erro: "Você não pode bloquear a si mesmo." } };
    const ok = await d.admin.atualizar(alvo, { ban_duration: acao === "bloquear" ? "876000h" : "none" });
    return ok ? { status: 200, json: { ok: true } } : { status: 500, json: { erro: "Não deu certo. Tente de novo." } };
  }
  return { status: 400, json: { erro: "?" } };
}

/* ---------- lançar (uma mensagem pode ter custos, movimentos e anotação juntos) ---------- */
const nfBR = (v: number, c = 0) => v.toLocaleString("pt-BR", { maximumFractionDigits: c });
const MSG_ANOTA = "📝 Anotei: ";
// acrescenta uma linha no bloco de notas do mês; devolve a linha ou "" se falhou
async function anota(d: Deps, conta: any, quem: string, texto: string) {
  const hoje = hojeMT(), mes = hoje.slice(0, 7);
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
  const dados = cfg?.dados || {}, notas = { ...(dados.notas || {}) };
  const linha = `${hoje.slice(8, 10)}/${hoje.slice(5, 7)} (${quem}): ${texto.trim().replace(/\s*\n\s*/g, " ")}`;
  notas[mes] = notas[mes] ? notas[mes].replace(/\s+$/, "") + "\n" + linha : linha;
  const { error } = await d.db.from("config").upsert({ fazenda_id: conta.fazenda_id, dados: { ...dados, notas }, updated_at: new Date().toISOString() }, { onConflict: "fazenda_id" });
  if (error) { console.error("upsert config", error); return ""; }
  return linha;
}
// Desfazer: tira a linha do bloco de notas (procura em todos os meses)
async function desanota(d: Deps, conta: any, linha: string) {
  if (!linha) return false;
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
  const dados = cfg?.dados || {}, notas = { ...(dados.notas || {}) };
  let achou = false;
  for (const mes of Object.keys(notas)) {
    const ls = String(notas[mes]).split("\n"), j = ls.lastIndexOf(linha);
    if (j >= 0) { ls.splice(j, 1); notas[mes] = ls.join("\n"); achou = true; break; }
  }
  if (!achou) return false;
  const { error } = await d.db.from("config").upsert({ fazenda_id: conta.fazenda_id, dados: { ...dados, notas }, updated_at: new Date().toISOString() }, { onConflict: "fazenda_id" });
  return !error;
}
// muda o config da fazenda em cima da versão atual do banco; fn devolve null quando não há o que mudar
async function mudaCfg(d: Deps, faz: string, fn: (dados: any) => any) {
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const novo = fn({ ...(cfg?.dados || {}) });
  if (!novo) return true;
  const { error } = await d.db.from("config").upsert({ fazenda_id: faz, dados: novo, updated_at: new Date().toISOString() }, { onConflict: "fazenda_id" });
  if (error) console.error("upsert config", error);
  return !error;
}
// pesagens: o mesmo lote escrito de jeitos diferentes ("Lote da Recria", "recria") vira a mesma chave
export const loteK = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/^(o|a)\s+/, "").replace(/^lote\s+(da|do|de|das|dos)\s+/, "").replace(/\s+/g, " ").trim();
// pesagem anterior do mesmo lote (antes da data)
// (com retiro: só as pesagens do mesmo retiro, porque o mesmo nome de lote pode existir nos dois)
const anterior = (lista: any[], lote: string, data: string, retiro?: string) =>
  lista.filter((p) => loteK(p.lote) === loteK(lote) && p.data < data && (retiro === undefined || (p.retiro || "") === (retiro || ""))).sort((a, b) => (a.data < b.data ? -1 : 1)).pop() || null;
const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const LIMPA_ENVIADOS = 60; // dias que um lembrete já avisado fica guardado

// áreas produtivas: grava no mesmo lugar dos Ajustes do app (retiros[].area, sede.area, area da fazenda toda)
// e guarda a versão anterior em areasDesf para o botão Desfazer
const FASES_A = ["cria", "recria", "engorda"];
export function aplicaAreas(D: any, areas: Area[], base: string, quem: string) {
  const rets = retirosDe(D).map((r: any) => ({ ...r, area: Number(r.area) || 0, areaFase: { ...(r.areaFase || {}) } }));
  const sede: any = { nome: GERAL, area: 0, ...(D.sede || {}) }; sede.areaFase = { ...(sede.areaFase || {}) };
  const antes = { area: D.area ?? 0, areaFase: D.areaFase ?? {}, retiros: D.retiros ?? null, sede: D.sede ?? null };
  let area = Number(D.area) || 0; const areaFase: any = { ...(D.areaFase || {}) };
  let totalDito = false; const fasesDitas = new Set<string>(); const linhas: string[] = [];
  for (const a of areas) {
    const ha = Math.round((Number(a.ha) || 0) * 10) / 10, fase = FASES_A.includes(a.fase) ? a.fase : "";
    if (ha <= 0) continue;
    const p = semAcento(String(a.parte || "")).replace(/^retiros+/, "");
    const toda = /fazenda toda|toda a fazenda|total|fazenda inteira/.test(p);
    const rid = toda ? "" : qualRetiro(rets, p);
    let alvo: any, nome: string;
    if (toda) { if (fase) { areaFase[fase] = ha; fasesDitas.add(fase); } else { area = ha; totalDito = true; } nome = "Fazenda toda"; }
    else { alvo = rid ? rets.find((r: any) => r.id === rid) : sede; nome = rid ? alvo.nome : sede.nome || GERAL;
      if (fase) alvo.areaFase[fase] = ha; else alvo.area = ha; }
    linhas.push(`📐 <b>Área produtiva</b> · ${esc(nome)}${fase ? " · " + fase : ""} · <b>${nfBR(ha, ha % 1 ? 1 : 0)} ha</b>`);
  }
  if (!linhas.length) return null;
  const partes = [...rets, sede];
  // fazenda toda = soma das partes, se a mensagem não disse o total
  if (!totalDito && partes.some((x) => x.area > 0)) area = Math.round(partes.reduce((s, x) => s + (Number(x.area) || 0), 0) * 10) / 10;
  for (const f of FASES_A) if (!fasesDitas.has(f) && partes.some((x) => +x.areaFase[f] > 0)) areaFase[f] = partes.reduce((s, x) => s + (+x.areaFase[f] || 0), 0);
  const novo = { ...D, area, areaFase, retiros: rets, sede,
    areasDesf: [...(D.areasDesf || []).slice(-9), { base, antes, por: quem, em: new Date().toISOString() }] };
  return { novo, linhas, total: area };
}

async function lancaNota(d: Deps, chat: number, conta: any, quem: string, texto: string) {
  const linha = await anota(d, conta, quem, texto);
  if (!linha) return responde(d, chat, "Não consegui salvar a anotação agora. Tente de novo.");
  return responde(d, chat, `${MSG_ANOTA}${esc(linha)}`, botoes(crypto.randomUUID()));
}
async function lanca(d: Deps, chat: number, conta: any, quem: string, L: Leitura, nota = "") {
  const hoje = hojeMT(), base = crypto.randomUUID(), criadoEm = new Date().toISOString();
  const autor = { criadoEm, porId: conta.user_id, por: quem, origem: d.origem || "telegram" };
  const txt: string[] = [], avisos: string[] = [];
  const cfgD = (await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle()).data?.dados || {};
  const kgA = Number(cfgD.kgArroba) || 30;
  // retiro de cada item: o citado na mensagem; sem citar, Sede (sem "retiro" nos dados)
  const rets = retirosDe(cfgD), usados = new Set<string>();
  const rid = (x: any) => { const r = rets.length ? qualRetiro(rets, x?.retiro || "") : ""; usados.add(r); return r; };
  const RT = (r: string) => (r ? { retiro: r } : {});

  // custos
  const custos: any[] = [];
  for (const c of L.custos || []) {
    const valor = Math.round((Number(c.valor) || 0) * 100) / 100;
    if (valor <= 0) continue;
    const item = ITN[c.item] ? c.item : "outros", onde = ONDE[c.onde] ? c.onde : "geral";
    const data = okData(c.data) && c.data <= hoje ? c.data : hoje;
    if (!okData(c.data) && nota) avisos.push("A nota não tinha data: usei hoje.");
    const id = `${base}-c${custos.length + 1}`, r = rid(c);
    custos.push({ id, fazenda_id: conta.fazenda_id, owner: conta.user_id, data, valor, item, grupo: ITG[item], centro: onde, lote_id: null, tipo: "custeio",
      dados: { data, valor, item, grupo: ITG[item], tipo: "custeio", descricao: c.descricao || "", centro: onde, loteId: "", ...(REB[c.rebanho || ""] ? { rebanho: c.rebanho } : {}), ...RT(r), ...autor, ...(nota && custos.length === 0 ? { nota } : {}) } });
    txt.push(`💸 <b>${esc(ITN[item])}</b> · <b>${brl(valor)}</b> · ${dBR(data)} · ${ONDE[onde]}${REB[c.rebanho || ""] ? " · " + REB[c.rebanho!] : ""}${tagRet(rets, r)}${c.descricao ? `\n   <i>${esc(c.descricao)}</i>` : ""}`);
  }

  // movimentos do rebanho
  const movs: any[] = [];
  if (L.movimentos?.length) {
    for (const m of L.movimentos) {
      const cab = Math.round(Number(m.cab) || 0);
      if (!TIPOS_MOV[m.mov] || cab <= 0) continue;
      const categoria = m.mov === "nascimento" ? (NASC.includes(m.categoria) ? m.categoria : "bezerros") : CATS[m.categoria] ? m.categoria : "outras";
      if (m.mov === "transferencia" && (!CATS[m.para] || m.para === categoria)) continue;
      const data = okData(m.data) && m.data <= hoje ? m.data : hoje;
      const peso = Number(m.peso_medio) > 0 ? Math.round(Number(m.peso_medio)) : 0, r = rid(m);
      const x: Record<string, unknown> = { tipo: m.mov, data, categoria, cab, pesoMedio: peso, obs: String(m.obs || "").trim() };
      if (m.mov === "transferencia") x.para = m.para;
      let valor: number | null = null;
      if (m.mov === "venda") {
        x.precoArroba = Number(m.preco_arroba) > 0 ? +m.preco_arroba : 0;
        valor = Number(m.valor) > 0 ? +m.valor : (x.precoArroba as number) && peso ? cab * peso / kgA * (x.precoArroba as number) : 0;
      }
      if (m.mov === "compra") valor = Number(m.valor) > 0 ? +m.valor : 0;
      if (valor != null) x.valor = Math.round(valor * 100) / 100;
      movs.push({ id: `${base}-m${movs.length + 1}`, fazenda_id: conta.fazenda_id, owner: conta.user_id, data, tipo: m.mov, categoria, cab,
        valor: valor == null ? null : x.valor, dados: { ...x, ...RT(r), ...autor } });
      txt.push(`🐄 <b>${TIPOS_MOV[m.mov]}</b> · ${nfBR(cab)} cab. · ${esc(CATS[categoria])}${m.mov === "transferencia" ? " → " + esc(CATS[m.para]) : ""}` +
        ` · ${dBR(data)}${peso ? ` · ${nfBR(peso)} kg` : ""}${x.valor ? " · " + brl(x.valor as number) : ""}${tagRet(rets, r)}${x.obs ? `\n   <i>${esc(x.obs as string)}</i>` : ""}`);
    }
  }

  // lembretes (aviso às 7h do dia)
  const lembs: any[] = [];
  for (const l of L.lembretes || []) {
    const texto = String(l.texto || "").trim();
    if (!texto) continue;
    if (!okData(l.data) || l.data < hoje) { avisos.push(`O lembrete "${texto}" ficou sem dia: mande de novo dizendo o dia.`); continue; }
    lembs.push({ id: `${base}-l${lembs.length + 1}`, data: l.data, texto, porId: conta.user_id, por: quem, criadoEm });
    txt.push(`⏰ <b>Lembrete</b> · ${dBR(l.data)} · ${esc(texto)}`);
  }

  // avisos de preço da arroba
  const alts: any[] = [];
  if (L.alertas?.length) {
    const cot = d.cotacao ? await d.cotacao().catch(() => null) : null;
    for (const a of L.alertas) {
      const valor = Math.round((Number(a.valor) || 0) * 100) / 100, acima = a.direcao !== "abaixo";
      if (valor <= 0) continue;
      const hojeTxt = cot ? `a arroba está em ${brl(cot.spot)} (B3 à vista, pregão de ${dBR(cot.data).slice(0, 5)})` : "";
      if (cot && (acima ? cot.spot >= valor : cot.spot <= valor)) {
        avisos.push(`Não marquei o aviso de ${brl(valor)}: ${hojeTxt}, já ${acima ? "acima" : "abaixo"} desse valor. Mande outro valor.`);
        continue;
      }
      alts.push({ id: `${base}-a${alts.length + 1}`, direcao: acima ? "acima" : "abaixo", valor, porId: conta.user_id, por: quem, criadoEm });
      txt.push(`📈 <b>Aviso da arroba</b> · quando o boi gordo ${acima ? "passar de" : "cair abaixo de"} <b>${brl(valor)}</b>/@${hojeTxt ? `\n   <i>${hojeTxt}</i>` : ""}`);
    }
  }

  // pesagens: ganho de peso desde a pesagem anterior do mesmo lote e, se o lote for um setor, o custo da @ produzida
  const pes: any[] = [];
  for (const p of L.pesagens || []) {
    const peso = Math.round((Number(p.peso_medio) || 0) * 10) / 10, lote = String(p.lote || "").trim().toLowerCase();
    if (peso <= 0 || !lote) continue;
    const data = okData(p.data) && p.data <= hoje ? p.data : hoje, cab = Math.max(0, Math.round(Number(p.cab) || 0)), r = rid(p);
    const novo = { id: `${base}-p${pes.length + 1}`, data, lote, cab, peso, ...RT(r), porId: conta.user_id, por: quem, criadoEm };
    let linha = `⚖️ <b>Pesagem</b> · ${esc(lote)} · ${cab ? nfBR(cab) + " cab. · " : ""}${nfBR(peso, 1)} kg · ${dBR(data)}${tagRet(rets, r)}`;
    const ant = anterior([...(cfgD.pesagens || []), ...pes], lote, data, rets.length ? r : undefined);
    if (ant) {
      const n = dias(ant.data, data), gmd = (peso - ant.peso) / n;
      linha += `\n   GMD <b>${gmd.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg/dia</b> em ${n} dias (eram ${nfBR(ant.peso, 1)} kg em ${dBR(ant.data)})`;
      const setor = loteK(lote), nc = cab || ant.cab;
      if (ONDE[setor] && setor !== "geral" && gmd > 0 && nc) {
        const gasto = (await todos(d, "desembolsos", conta.fazenda_id, somaDias(ant.data, 1)))
          .filter((x) => x.data <= data && x.centro === setor && x.tipo !== "investimento" && (!rets.length || (x.retiro || "") === r)).reduce((s, x) => s + (Number(x.valor) || 0), 0);
        const arr = nc * (peso - ant.peso) / kgA;
        if (gasto > 0) linha += `\n   Custo da @ produzida: <b>${brl(gasto / arr)}</b> (${brl(gasto)} lançados na ${ONDE[setor]} ÷ ${nfBR(arr, 1)} @)`;
      }
    } else linha += "\n   <i>Primeira pesagem deste lote: na próxima eu calculo o ganho de peso.</i>";
    pes.push(novo);
    txt.push(linha);
  }

  // contas a pagar: marca as novas; as pagas viram custo agora (no lugar de um custo comum)
  const novas: any[] = [], pagas: any[] = [], proxs: any[] = [], lista = abertas(cfgD);
  for (const c of L.contas || []) {
    const valor = Math.round((Number(c.valor) || 0) * 100) / 100;
    if (valor <= 0 || !okData(c.vencimento)) { avisos.push(`A conta "${c.descricao || "?"}" ficou de fora: falta o valor ou o vencimento.`); continue; }
    const item = ITN[c.item] ? c.item : "outros", r = rid(c);
    novas.push({ id: `${base}-b${novas.length + 1}`, descricao: String(c.descricao || ITN[item]).trim(), valor, venc: c.vencimento, item, centro: ONDE[c.onde] ? c.onde : "geral",
      ...(c.mensal ? { mensal: true, dia: +c.vencimento.slice(8) } : {}), ...RT(r), porId: conta.user_id, por: quem, criadoEm });
    txt.push(`🧾 <b>Conta a pagar</b> · ${linhaConta(novas[novas.length - 1], rets)}`);
  }
  if (novas.length) avisos.push("Aviso na véspera e no dia do vencimento, com o botão Paguei.");
  for (const n of [...new Set(L.pagou || [])]) {
    const c = lista[n - 1];
    if (!c) continue;
    const id = `${base}-c${custos.length + 1}`, item = ITN[c.item] ? c.item : "outros", centro = ONDE[c.centro] ? c.centro : "geral";
    const dp = dataPaga(c, hoje), px = proxConta(c, quem, conta.user_id);
    if (px) proxs.push(px);
    custos.push({ id, fazenda_id: conta.fazenda_id, owner: conta.user_id, data: dp, valor: c.valor, item, grupo: ITG[item], centro, lote_id: null, tipo: "custeio",
      dados: { data: dp, valor: c.valor, item, grupo: ITG[item], tipo: "custeio", descricao: `Conta paga: ${c.descricao}`, centro, loteId: "", contaId: c.id, ...RT(c.retiro || ""), ...autor } });
    usados.add(rets.some((r) => r.id === c.retiro) ? c.retiro : "");
    pagas.push(c.id);
    txt.push(`✅ <b>Conta paga</b> · ${esc(c.descricao)} · <b>${brl(c.valor)}</b> · lancei como custo de ${dp === hoje ? "hoje" : dBR(dp)}${tagRet(rets, c.retiro || "")}${px ? `\n   🔁 Próxima marcada: vence ${dBR(px.venc)}` : ""}`);
  }

  // áreas produtivas (vão para os Ajustes do app)
  let nAreas = 0;
  if (L.areas?.length) {
    const t = aplicaAreas(cfgD, L.areas, base, quem);
    if (t) { nAreas = t.linhas.length; txt.push(...t.linhas); txt.push(`   <i>Fazenda toda: ${nfBR(t.total, t.total % 1 ? 1 : 0)} ha. Já está nos Ajustes do app.</i>`); }
  }

  const temNota = !!String(L.anotacao || "").trim();
  if (!custos.length && !movs.length && !lembs.length && !alts.length && !pes.length && !novas.length && !nAreas && !temNota)
    return responde(d, chat, esc([...avisos, L.resposta || ""].filter(Boolean).join(" ") || "Não entendi o que lançar. Escreva o valor e o que foi comprado, ou quantas cabeças e o que aconteceu."));

  // grava: se uma parte falhar, desfaz o que já entrou para não ficar pela metade
  if (custos.length) {
    const { error } = await d.db.from("desembolsos").insert(custos);
    if (error) { console.error("insert desembolsos", error); return responde(d, chat, "Não consegui salvar agora. Tente de novo em instantes."); }
  }
  if (movs.length) {
    const { error } = await d.db.from("movimentos").insert(movs);
    if (error) {
      console.error("insert movimentos", error);
      if (custos.length) await d.db.from("desembolsos").delete().eq("fazenda_id", conta.fazenda_id).like("id", base + "-%");
      return responde(d, chat, "Não consegui salvar agora. Tente de novo em instantes.");
    }
  }
  if (lembs.length || alts.length || pes.length || novas.length || pagas.length || nAreas) {
    const ok = await mudaCfg(d, conta.fazenda_id, (D0) => { const D = nAreas ? aplicaAreas(D0, L.areas!, base, quem)!.novo : D0; return { ...D,
      ...(novas.length || pagas.length ? { contas: [...(D.contas || []).map((x: any) => (pagas.includes(x.id) ? { ...x, paga: { data: hoje, base, por: quem } } : x)), ...novas, ...proxs] } : {}),
      ...(lembs.length ? { lembretes: [...(D.lembretes || []), ...lembs] } : {}),
      ...(alts.length ? { alertas: [...(D.alertas || []), ...alts] } : {}),
      ...(pes.length ? { pesagens: [...(D.pesagens || []), ...pes] } : {}) }; });
    if (!ok) {
      if (custos.length) await d.db.from("desembolsos").delete().eq("fazenda_id", conta.fazenda_id).like("id", base + "-%");
      if (movs.length) await d.db.from("movimentos").delete().eq("fazenda_id", conta.fazenda_id).like("id", base + "-%");
      return responde(d, chat, "Não consegui salvar agora. Tente de novo em instantes.");
    }
  }
  let linhaNota = "";
  if (temNota) {
    linhaNota = await anota(d, conta, quem, String(L.anotacao));
    if (!linhaNota) avisos.push("A anotação não foi salva: mande de novo com \"anotar:\".");
  }

  const tot = custos.length + movs.length + lembs.length + alts.length + pes.length + novas.length + nAreas, temRet = rets.length > 0 && custos.length + movs.length + pes.length > 0, ret = usados.size === 1 ? [...usados][0] : "?";
  const msg = (tot ? `✅ <b>Lancei ${tot === 1 ? "1 item" : tot + " itens"}:</b>\n${txt.join("\n")}` : "") +
    (linhaNota ? `${tot ? "\n" : ""}${MSG_ANOTA}${esc(linhaNota)}` : "") +
    (nota && custos.length ? "\n📎 A foto ficou guardada no app junto do custo." : "") +
    (avisos.length ? `\n<i>${esc([...new Set(avisos)].join(" "))}</i>` : "") +
    (L.resposta ? `\n⚠️ ${esc(L.resposta)}` : "") +
    (custos.length === 1 && tot === 1 ? "\nSe o setor estiver errado, toque nele abaixo." : "");
  return responde(d, chat, msg, botoes(base, custos.length === 1 && tot === 1 ? custos[0].id : "", custos[0]?.centro, temRet ? rets : [], ret));
}

/* ---------- dados da fazenda (para o resumo e as perguntas) ---------- */
const somaDias = (s: string, n: number) => { const t = new Date(s + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
async function todos(d: Deps, tabela: string, fazenda: string, desde = "") {
  const out: any[] = [];
  for (let i = 0; ; i += 1000) {
    let q = d.db.from(tabela).select("dados").eq("fazenda_id", fazenda);
    if (desde) q = q.gte("data", desde);
    const { data, error } = await q.range(i, i + 999);
    if (error) { console.error("ler " + tabela, error); break; }
    out.push(...(data || []).map((r: any) => r.dados || {}));
    if (!data || data.length < 1000) break;
  }
  return out;
}
// mesmo cálculo do app: último fechamento + movimentos depois dele
function rebanhoHoje(fechs: any[], movs: any[]) {
  const base = [...fechs].filter((f) => f.mes && f.cats).sort((a, b) => (a.mes < b.mes ? -1 : 1)).pop();
  if (!base) return null;
  const cats: Record<string, number> = {};
  Object.keys(CATS).forEach((c) => (cats[c] = Number(base.cats[c]?.cab) || 0));
  movs.filter((x) => String(x.data || "").slice(0, 7) > base.mes).forEach((x) => {
    const n = Number(x.cab) || 0;
    if (x.tipo === "nascimento" || x.tipo === "compra") cats[x.categoria] = (cats[x.categoria] || 0) + n;
    else if (x.tipo === "venda" || x.tipo === "morte") cats[x.categoria] = (cats[x.categoria] || 0) - n;
    else if (x.tipo === "transferencia" && cats[x.para] != null) { cats[x.categoria] -= n; cats[x.para] += n; }
  });
  Object.keys(cats).forEach((c) => (cats[c] = Math.max(0, Math.round(cats[c]))));
  return { mes: base.mes, cats, total: Object.values(cats).reduce((a, b) => a + b, 0) };
}

// rebanho da fazenda toda hoje: soma o de cada parte (retiros e Sede), cada uma com o seu último fechamento + movimentos depois;
// parte que ainda não tem fechamento entra com o saldo dos movimentos lançados depois do fechamento mais antigo das outras
function rebanhoTotal(fechs: any[], movs: any[], rets: Retiro[]) {
  let total = 0, base = "";
  const sem: Grupo[] = [];
  for (const g of grupos(rets)) {
    const R = rebanhoHoje(fechs.filter(g.f), movs.filter(g.f));
    if (R) { total += R.total; if (!base || R.mes < base) base = R.mes; } else sem.push(g);
  }
  if (!base) return null;
  sem.forEach((g) => movs.filter(g.f).filter((x) => String(x.data || "").slice(0, 7) > base).forEach((x) => {
    const n = Number(x.cab) || 0;
    if (x.tipo === "nascimento" || x.tipo === "compra") total += n; else if (x.tipo === "venda" || x.tipo === "morte") total -= n;
  }));
  return { mes: base, cats: null as any, total: Math.max(0, Math.round(total)) };
}
/* ---------- grupos dos resumos: um por retiro e a Sede (lançamentos sem retiro) ---------- */
type Grupo = { nome: string; sem?: boolean; f: (x: any) => boolean };
function grupos(rets: Retiro[], ...listas: any[][]): Grupo[] {
  if (!rets.length) return [{ nome: "", f: () => true }];
  const ids = new Set(rets.map((r) => r.id));
  const G: Grupo[] = rets.map((r) => ({ nome: r.nome, f: (x: any) => x.retiro === r.id }));
  G.push({ nome: GERAL, sem: true, f: (x: any) => !ids.has(x.retiro) });
  return G;
}
const tituloG = (g: Grupo) => (g.nome ? `🏠 <b>${esc(g.sem ? g.nome : "Retiro " + g.nome)}</b>\n` : "");
const somaV = (a: any[]) => a.reduce((s, x) => s + (Number(x.valor) || 0), 0);
// "5 nascimentos · 1 morte · 20 vendidos (R$ ...)"
function rebTxt(movs: any[], comValor: boolean) {
  const cab = (t: string) => movs.filter((x) => x.tipo === t).reduce((a, x) => a + (Number(x.cab) || 0), 0);
  const val = (t: string) => somaV(movs.filter((x) => x.tipo === t));
  return [
    cab("nascimento") && `${nfBR(cab("nascimento"))} ${cab("nascimento") === 1 ? "nascimento" : "nascimentos"}`,
    cab("morte") && `${nfBR(cab("morte"))} ${cab("morte") === 1 ? "morte" : "mortes"}`,
    cab("venda") && `${nfBR(cab("venda"))} vendidos${comValor && val("venda") ? ` (${brl(val("venda"))})` : ""}`,
    cab("compra") && `${nfBR(cab("compra"))} comprados${comValor && val("compra") ? ` (${brl(val("compra"))})` : ""}`,
    cab("transferencia") && `${nfBR(cab("transferencia"))} mudaram de categoria`,
  ].filter(Boolean).join(" · ");
}
const topItens = (gastos: any[], n: number) => {
  const p: Record<string, number> = {};
  gastos.forEach((x) => (p[x.item] = (p[x.item] || 0) + (Number(x.valor) || 0)));
  return Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, n);
};

/* ---------- resumo semanal (GitHub Actions chama ?resumo=1 toda segunda) ---------- */
export async function resumoSemanal(d: Deps) {
  const hoje = hojeMT(), dow = new Date(hoje + "T12:00:00Z").getUTCDay();
  if (dow !== 1) return "só às segundas";
  const ini = somaDias(hoje, -7), fim = somaDias(hoje, -1); // segunda a domingo da semana passada
  // uma vez por semana: se alguém chamar de novo, não manda repetido
  const { error: ja } = await d.db.from("telegram_updates").insert({ update_id: -Number(ini.replace(/-/g, "")) });
  if (ja) return "já enviado";
  const { data: contas } = await d.db.from("telegram_contas").select("chat_id,fazenda_id");
  const porFaz: Record<string, number[]> = {};
  (contas || []).forEach((c: any) => (porFaz[c.fazenda_id] ||= []).push(c.chat_id));
  let n = 0;
  for (const [faz, chats] of Object.entries(porFaz)) {
    const { data: fz } = await d.db.from("fazendas").select("nome").eq("id", faz).maybeSingle();
    const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
    const movs = await todos(d, "movimentos", faz), fechs = await todos(d, "fechamentos", faz);
    const semana = movs.filter((x) => x.data >= ini && x.data <= fim);
    const gastos = (await todos(d, "desembolsos", faz, ini)).filter((x) => x.data <= fim);
    const blocos: string[] = [];
    const retsS = retirosDe(cfg?.dados), RT = rebanhoTotal(fechs, movs, retsS);
    for (const g of grupos(retsS)) {
      const sm = semana.filter(g.f), gs = gastos.filter(g.f), R = !g.nome ? null : rebanhoHoje(fechs.filter(g.f), movs.filter(g.f));
      if (g.nome && !sm.length && !gs.length && !R) continue; // retiro sem nada lançado ainda
      const tot = somaV(gs), top = topItens(gs, 3).map(([k, v]) => `${ITN[k] || "Outros"} ${brl(v)}`), reb = rebTxt(sm, true);
      blocos.push(tituloG(g) +
        `🐄 <b>Rebanho:</b> ${reb || "nenhum movimento lançado"}\n` +
        `💸 <b>Custos:</b> ${tot ? brl(tot) + (top.length ? `\n   ${esc(top.join(" · "))}` : "") : "nenhum custo lançado"}` +
        (R ? `\n🐮 <b>Rebanho hoje:</b> ${nfBR(R.total)} cabeças` : ""));
    }
    if (!blocos.length) blocos.push("🐄 <b>Rebanho:</b> nenhum movimento lançado\n💸 <b>Custos:</b> nenhum custo lançado");
    const txt = `📊 <b>Resumo da semana</b> · ${dBR(ini).slice(0, 5)} a ${dBR(fim)}${fz?.nome ? "\n" + esc(fz.nome) : ""}\n\n` +
      blocos.join("\n\n") +
      `\n\n📊 <b>Total da fazenda:</b> custos ${brl(somaV(gastos))}${RT ? ` · ${nfBR(RT.total)} cabeças hoje` : ""}` +
      (RT ? `\n<i>Rebanho hoje = último fechamento do mês + movimentos lançados depois.</i>` : "") +
      `\n\nPergunte o que quiser, ex.: <i>quantas vacas eu tenho?</i>`;
    for (const chat of chats) { await d.tg("sendMessage", { chat_id: chat, text: txt, parse_mode: "HTML" }); n++; }
    try { await mandaBackup(d, faz, chats, fz?.nome || ""); } catch (e) { console.error("backup semanal", e); }
  }
  return `enviado para ${n} conversa(s)`;
}

/* ---------- relatório mensal: todo dia 1º, sobre o mês que acabou (vem junto da chamada ?avisos=1 das 7h) ---------- */
const pctTxt = (a: number, b: number) => { if (!b) return ""; const p = (a / b - 1) * 100; return `${p >= 0 ? "+" : ""}${p.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`; };
const gmdTxt = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
// so: manda só para uma conversa, na hora (comando "relatório"), sem esperar o dia 1º
export async function relatorioMensal(d: Deps, so?: { faz: string; chat: number }) {
  const hoje = hojeMT(), forcar = !!so;
  if (hoje.slice(8) !== "01" && !forcar) return "só no dia 1º";
  const ini = somaDias(hoje.slice(0, 7) + "-01", -1).slice(0, 7) + "-01", mes = ini.slice(0, 7), fim = somaDias(hoje.slice(0, 7) + "-01", -1);
  const iniAnt = somaDias(ini, -1).slice(0, 7) + "-01", nomeMes = MESF[+mes.slice(5) - 1], nomeAnt = MESF[+iniAnt.slice(5, 7) - 1];
  // uma vez por mês: se alguém chamar de novo, não manda repetido
  if (!forcar) { const { error: ja } = await d.db.from("telegram_updates").insert({ update_id: -Number(mes.replace("-", "")) }); if (ja) return "já enviado"; }
  const porFaz: Record<string, number[]> = {};
  if (so) porFaz[so.faz] = [so.chat];
  else ((await d.db.from("telegram_contas").select("chat_id,fazenda_id")).data || []).forEach((c: any) => (porFaz[c.fazenda_id] ||= []).push(c.chat_id));
  let n = 0;
  for (const [faz, chats] of Object.entries(porFaz)) {
    const { data: fz } = await d.db.from("fazendas").select("nome").eq("id", faz).maybeSingle();
    const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
    const D = cfg?.dados || {}, rets = retirosDe(D);
    const movs = await todos(d, "movimentos", faz), fechs = await todos(d, "fechamentos", faz);
    const doMes = movs.filter((x) => x.data >= ini && x.data <= fim);
    const gastosT = (await todos(d, "desembolsos", faz, iniAnt)).filter((x) => x.data <= fim);
    const gastos = gastosT.filter((x) => x.data >= ini), gastosAnt = gastosT.filter((x) => x.data < ini);
    const P = D.pesagens || [], Pm = P.filter((p: any) => p.data >= ini && p.data <= fim);
    const blocos: string[] = [], faltaFech: string[] = [];
    const RT = rebanhoTotal(fechs, movs, rets);
    for (const g of grupos(rets)) {
      const dm = doMes.filter(g.f), gs = gastos.filter(g.f), ga = gastosAnt.filter(g.f), R = !g.nome ? null : rebanhoHoje(fechs.filter(g.f), movs.filter(g.f));
      const pg = Pm.filter(g.f).sort((a: any, b: any) => (a.data < b.data ? -1 : 1));
      if (g.nome && fechs.some((f) => g.f(f)) && !fechs.some((f) => f.mes === mes && g.f(f))) faltaFech.push(g.nome);
      if (g.nome && !dm.length && !gs.length && !R && !pg.length) continue; // retiro sem nada lançado ainda
      const tot = somaV(gs), totAnt = somaV(ga), invest = somaV(gs.filter((x) => x.tipo === "investimento"));
      const porSetor: Record<string, number> = {};
      gs.forEach((x) => { const s = ONDE[x.centro] ? x.centro : "geral"; porSetor[s] = (porSetor[s] || 0) + (Number(x.valor) || 0); });
      const top = topItens(gs, 5).map(([k, v]) => `   • ${esc(ITN[k] || "Outros")}: ${brl(v)} (${(v / tot * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%)`);
      const setores = Object.keys(ONDE).filter((k) => porSetor[k]).map((k) => `${ONDE[k]} ${brl(porSetor[k])}`);
      const vendas = somaV(dm.filter((x) => x.tipo === "venda")), compras = somaV(dm.filter((x) => x.tipo === "compra")), saldo = vendas - compras - tot;
      const pes = pg.map((p: any) => {
        const a = anterior(P, p.lote, p.data, rets.length ? p.retiro || "" : undefined), nd = a ? dias(a.data, p.data) : 0;
        return `   • ${esc(p.lote)}: ${nfBR(p.peso, 1)} kg em ${dBR(p.data).slice(0, 5)}` + (a && nd ? ` · GMD ${gmdTxt((p.peso - a.peso) / nd)} kg/dia` : "");
      });
      blocos.push(tituloG(g) +
        `🐄 <b>Rebanho no mês:</b> ${rebTxt(dm, false) || "nenhum movimento lançado"}\n` +
        (R ? `   Hoje: <b>${nfBR(R.total)} cabeças</b>\n` : "") +
        `💸 <b>Custos: ${brl(tot)}</b>` + (totAnt ? ` (${pctTxt(tot, totAnt)} sobre ${nomeAnt})` : "") + "\n" +
        (top.length ? top.join("\n") + "\n" : "") +
        (setores.length > 1 || (setores.length === 1 && !porSetor.geral) ? `   Por setor: ${setores.join(" · ")}\n` : "") +
        (invest ? `   Desse total, ${brl(invest)} foram investimento.\n` : "") +
        (vendas || compras ? `💰 <b>Gado:</b>${vendas ? ` vendas ${brl(vendas)}` : ""}${vendas && compras ? " ·" : ""}${compras ? ` compras ${brl(compras)}` : ""}\n` +
          `   Vendas − compras − custos: <b>${brl(saldo)}</b>\n` : "") +
        (pes.length ? `⚖️ <b>Pesagens</b>\n${pes.join("\n")}\n` : ""));
    }
    if (!blocos.length) blocos.push(`🐄 <b>Rebanho no mês:</b> nenhum movimento lançado\n💸 <b>Custos: ${brl(0)}</b>\n`);
    if (!fechs.some((f) => f.mes === mes) && !faltaFech.length) faltaFech.push("");
    const totM = somaV(gastos), vendM = somaV(doMes.filter((x) => x.tipo === "venda")), compM = somaV(doMes.filter((x) => x.tipo === "compra"));
    const contasMes = abertas(D).filter((c: any) => c.venc.slice(0, 7) <= hoje.slice(0, 7))
      .map((c: any) => `   • ${dBR(c.venc).slice(0, 5)} · ${esc(c.descricao)} · ${brl(c.valor)}${c.venc < hoje ? " ⚠️ vencida" : ""}`);
    const prox = (D.lembretes || []).filter((x: any) => !x.enviado && x.data.slice(0, 7) === hoje.slice(0, 7)).sort((a: any, b: any) => (a.data < b.data ? -1 : 1))
      .map((x: any) => `   • ${dBR(x.data).slice(0, 5)} · ${esc(x.texto)}`);
    const txt = `📅 <b>Relatório de ${nomeMes} de ${mes.slice(0, 4)}</b>${fz?.nome ? "\n" + esc(fz.nome) : ""}\n\n` +
      blocos.join("\n") +
      `\n📊 <b>Total da fazenda:</b> custos ${brl(totM)}${vendM || compM ? ` · vendas ${brl(vendM)} · compras ${brl(compM)} · saldo <b>${brl(vendM - compM - totM)}</b>` : ""}${RT ? ` · ${nfBR(RT.total)} cabeças hoje` : ""}\n` +
      (contasMes.length ? `\n🧾 <b>Contas a pagar em ${MESF[+hoje.slice(5, 7) - 1]}</b>\n${contasMes.join("\n")}\n` : "") +
      (prox.length ? `\n⏰ <b>Lembretes de ${MESF[+hoje.slice(5, 7) - 1]}</b>\n${prox.join("\n")}\n` : "") +
      (faltaFech.length ? `\n👉 Falta o <b>fechamento de ${nomeMes}</b> no app${faltaFech[0] ? ` (${esc(faltaFech.join(" e "))})` : ""}: contar o gado e o peso de cada categoria. Com ele saem produção, GMD e lotação do mês.\n` : "") +
      `\nPergunte o que quiser, ex.: <i>qual foi meu maior gasto em ${nomeMes}?</i>`;
    for (const chat of chats) { await d.tg("sendMessage", { chat_id: chat, text: txt, parse_mode: "HTML" }); n++; }
    // no dia 1º vai junto a planilha do mês para o contador
    if (!so) {
      try { await mandaPlanilha(d, faz, chats, mes, fz?.nome || ""); } catch (e) { console.error("planilha do mês", e); }
      try { await mandaNotas(d, faz, chats, mes, fz?.nome || ""); } catch (e) { console.error("fotos das notas", e); }
      if (mes.endsWith("-12")) { try { await mandaPlanilhaAno(d, faz, chats, mes.slice(0, 4), fz?.nome || ""); } catch (e) { console.error("planilha do ano", e); } }
    }
  }
  return `relatório mensal enviado para ${n} conversa(s)`;
}

/* ---------- planilha do mês para o contador (Excel): resumo + uma aba por parte da fazenda ---------- */
// valores em reais vão como { $: número } para a planilha formatar como moeda
export type Aba = { nome: string; linhas: any[][]; larguras: number[] };
const R$ = (v: number) => ({ $: Math.round((Number(v) || 0) * 100) / 100 });
const fimMes = (mes: string) => new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5, 7), 0)).toISOString().slice(0, 10);
const dBR4 = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
export async function planilhaMes(d: Deps, faz: string, mes: string, nomeFaz = "") {
  const ini = mes + "-01", fim = fimMes(mes), nomeMes = `${MESF[+mes.slice(5, 7) - 1]} de ${mes.slice(0, 4)}`;
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const G = grupos(retirosDe(cfg?.dados)), nomeG = (g: Grupo) => g.nome || "Fazenda";
  const porData = (a: any, b: any) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0);
  const gastos = (await todos(d, "desembolsos", faz, ini)).filter((x) => x.data <= fim).sort(porData);
  const gado = (await todos(d, "movimentos", faz, ini)).filter((x) => x.data <= fim && (x.tipo === "venda" || x.tipo === "compra")).sort(porData);
  const soma = (a: any[]) => a.reduce((s, x) => s + (Number(x.valor) || 0), 0), inv = (x: any) => x.tipo === "investimento";
  const titulo = `${nomeFaz || "Fazenda"} · ${nomeMes}`;

  // resumo: uma linha por parte e o total
  const resumo: any[][] = [[`Caderno da Fazenda · ${titulo}`], ["Valores em reais, lançados no app e pelo robô do Telegram."], [],
    ["Parte", "Custeio", "Investimento", "Total de custos", "Vendas de gado", "Compras de gado", "Saldo (vendas − compras − custos)"]];
  const tot = [0, 0, 0, 0];
  for (const g of G) {
    const c = gastos.filter(g.f), m = gado.filter(g.f);
    const cus = soma(c.filter((x) => !inv(x))), iv = soma(c.filter(inv)), v = soma(m.filter((x) => x.tipo === "venda")), cp = soma(m.filter((x) => x.tipo === "compra"));
    tot[0] += cus; tot[1] += iv; tot[2] += v; tot[3] += cp;
    resumo.push([nomeG(g), R$(cus), R$(iv), R$(cus + iv), R$(v), R$(cp), R$(v - cp - cus - iv)]);
  }
  if (G.length > 1) resumo.push(["Fazenda toda", R$(tot[0]), R$(tot[1]), R$(tot[0] + tot[1]), R$(tot[2]), R$(tot[3]), R$(tot[2] - tot[3] - tot[0] - tot[1])]);
  // custos por tipo, com uma coluna por parte
  const itens = [...new Set(gastos.map((x) => ITN[x.item] ? x.item : "outros"))].sort((a, b) => soma(gastos.filter((x) => x.item === b)) - soma(gastos.filter((x) => x.item === a)));
  if (itens.length) {
    resumo.push([], ["Custos por tipo"], ["Tipo de custo", ...G.map(nomeG), ...(G.length > 1 ? ["Fazenda toda"] : [])]);
    for (const it of itens) {
      const a = gastos.filter((x) => (ITN[x.item] ? x.item : "outros") === it);
      resumo.push([ITN[it], ...G.map((g) => R$(soma(a.filter(g.f)))), ...(G.length > 1 ? [R$(soma(a))] : [])]);
    }
  }
  const abas: Aba[] = [{ nome: "Resumo", linhas: resumo, larguras: [34, 16, 16, 16, 16, 16, 18] }];

  // visão geral: todos os lançamentos do mês juntos, com a parte de cada um
  if (G.length > 1) {
    const parte = (x: any) => nomeG(G.find((g) => g.f(x)) || G[G.length - 1]);
    const L: any[][] = [[`Fazenda toda · ${titulo}`], ["Todos os lançamentos do mês; a coluna Parte diz de qual parte é cada um."], [], ["CUSTOS"],
      ["Data", "Parte", "Tipo de custo", "Setor", "Custeio ou investimento", "Descrição", "Valor (R$)", "Lançado por", "Foto da nota"]];
    gastos.forEach((x) => L.push([dBR4(x.data), parte(x), ITN[x.item] || "Outros gastos", ONDE[x.centro] || ONDE.geral, inv(x) ? "Investimento" : "Custeio",
      x.descricao || "", R$(x.valor), x.por || "", x.nota ? "sim, no app" : ""]));
    if (!gastos.length) L.push(["nenhum custo lançado no mês"]);
    L.push(["", "", "", "", "", "Total de custos", R$(soma(gastos))], [], ["VENDAS E COMPRAS DE GADO"],
      ["Data", "Parte", "Tipo", "Categoria", "Cabeças", "Peso médio (kg)", "Preço da @ (R$)", "Valor (R$)", "Observação", "Lançado por"]);
    gado.forEach((x) => L.push([dBR4(x.data), parte(x), TIPOS_MOV[x.tipo], CATS[x.categoria] || "", Number(x.cab) || 0, Number(x.pesoMedio) || "",
      Number(x.precoArroba) ? R$(x.precoArroba) : "", R$(x.valor), x.obs || "", x.por || ""]));
    if (!gado.length) L.push(["nenhuma venda ou compra de gado no mês"]);
    else L.push(["", "", "", "", "", "", "Vendas", R$(soma(gado.filter((x) => x.tipo === "venda")))], ["", "", "", "", "", "", "Compras", R$(soma(gado.filter((x) => x.tipo === "compra")))]);
    abas.push({ nome: "Fazenda toda", linhas: L, larguras: [12, 16, 30, 16, 20, 36, 16, 18, 22, 16] });
  }

  // uma aba por parte: custos e gado do mês, linha a linha
  for (const g of G) {
    const c = gastos.filter(g.f), m = gado.filter(g.f), L: any[][] = [[`${nomeG(g)} · ${titulo}`], [], ["CUSTOS"],
      ["Data", "Tipo de custo", "Setor", "Custeio ou investimento", "Descrição", "Valor (R$)", "Lançado por", "Foto da nota"]];
    c.forEach((x) => L.push([dBR4(x.data), ITN[x.item] || "Outros gastos", ONDE[x.centro] || ONDE.geral, inv(x) ? "Investimento" : "Custeio",
      x.descricao || "", R$(x.valor), x.por || "", x.nota ? "sim, no app" : ""]));
    if (!c.length) L.push(["nenhum custo lançado no mês"]);
    L.push(["", "", "", "", "Total de custos", R$(soma(c))], [], ["VENDAS E COMPRAS DE GADO"],
      ["Data", "Tipo", "Categoria", "Cabeças", "Peso médio (kg)", "Preço da @ (R$)", "Valor (R$)", "Observação", "Lançado por"]);
    m.forEach((x) => L.push([dBR4(x.data), TIPOS_MOV[x.tipo], CATS[x.categoria] || "", Number(x.cab) || 0, Number(x.pesoMedio) || "",
      Number(x.precoArroba) ? R$(x.precoArroba) : "", R$(x.valor), x.obs || "", x.por || ""]));
    if (!m.length) L.push(["nenhuma venda ou compra de gado no mês"]);
    else L.push(["", "", "", "", "", "Vendas", R$(soma(m.filter((x) => x.tipo === "venda")))], ["", "", "", "", "", "Compras", R$(soma(m.filter((x) => x.tipo === "compra")))]);
    abas.push({ nome: nomeG(g).slice(0, 31), linhas: L, larguras: [12, 30, 16, 20, 36, 16, 18, 22, 16] });
  }
  return { abas, nCustos: gastos.length, nGado: gado.length, nomeMes, partes: G.map(nomeG) };
}
export async function mandaPlanilha(d: Deps, faz: string, chats: number[], mes: string, nomeFaz = "") {
  if (!d.planilha || !d.envia || !chats.length) return 0;
  const P = await planilhaMes(d, faz, mes, nomeFaz), bytes = d.planilha(P.abas);
  const slug = (nomeFaz || "fazenda").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "fazenda";
  const legenda = `📊 <b>Planilha de ${P.nomeMes} para o contador</b>\n${nfBR(P.nCustos)} custos e ${nfBR(P.nGado)} vendas/compras de gado.` +
    (P.partes.length > 1 ? `\nAbas: Resumo, Fazenda toda (tudo junto) e uma para cada parte: ${esc(P.partes.join(", "))}.` : "") +
    `\nÉ só encaminhar este arquivo ao contador.`;
  let n = 0;
  for (const chat of chats) { const r = await d.envia(chat, `contador-${slug}-${mes}.xlsx`, bytes, legenda, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); if (r?.ok !== false) n++; }
  return n;
}
// "planilha", "planilha de outubro": de que mês (sem dizer, o mês passado; mês que ainda não chegou neste ano é do ano passado)
export function mesPedido(cmd: string, hoje: string) {
  const m = MESF.findIndex((x) => cmd.includes(semAcento(x)) || cmd.includes(x));
  if (m < 0) return somaDias(hoje.slice(0, 7) + "-01", -1).slice(0, 7);
  const ano = +hoje.slice(0, 4) - (m + 1 > +hoje.slice(5, 7) ? 1 : 0);
  return `${ano}-${String(m + 1).padStart(2, "0")}`;
}

const porDataG = (a: any, b: any) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0);
const slugF = (s: string) => (s || "fazenda").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "fazenda";

/* ---------- fotos das notas do mês num zip, uma pasta por parte (para o contador) ---------- */
export async function mandaNotas(d: Deps, faz: string, chats: number[], mes: string, nomeFaz = "", avisaVazio = false) {
  if (!d.baixaNota || !d.zip || !d.envia || !chats.length) return 0;
  const ini = mes + "-01", fim = fimMes(mes), nomeMes = `${MESF[+mes.slice(5, 7) - 1]} de ${mes.slice(0, 4)}`;
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const G = grupos(retirosDe(cfg?.dados));
  const gastos = (await todos(d, "desembolsos", faz, ini)).filter((x) => x.data <= fim && x.nota).sort(porDataG);
  if (!gastos.length) {
    if (avisaVazio) for (const chat of chats) await d.tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `Nenhuma foto de nota guardada em ${nomeMes}. As fotos entram quando a nota é mandada pelo Telegram ou anexada no app.` });
    return 0;
  }
  const arquivos: Record<string, Uint8Array> = {}, usados = new Set<string>();
  let falhou = 0;
  for (const x of gastos) {
    const b = await d.baixaNota(x.nota).catch(() => null);
    if (!b) { falhou++; continue; }
    const pasta = (G.find((g) => g.f(x)) || {} as Grupo).nome || "Fazenda", ext = String(x.nota).match(/\.(\w+)$/)?.[1] || "jpg";
    const nome = `${pasta}/${x.data} ${ITN[x.item] || "Outros gastos"} R$ ${(Number(x.valor) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.replace(/[\\:*?"<>|]/g, "");
    let k = nome, i = 2;
    while (usados.has(k)) k = `${nome} (${i++})`;
    usados.add(k);
    arquivos[`${k}.${ext}`] = b;
  }
  if (!Object.keys(arquivos).length) {
    if (avisaVazio) for (const chat of chats) await d.tg("sendMessage", { chat_id: chat, text: "Não consegui pegar as fotos das notas agora. Tente de novo em instantes." });
    return 0;
  }
  // o Telegram aceita arquivos de até 50 MB: divide em partes de uns 45 MB
  const partes: Record<string, Uint8Array>[] = [{}];
  let tam = 0;
  for (const [n, b] of Object.entries(arquivos)) {
    if (tam + b.length > 45e6 && Object.keys(partes[partes.length - 1]).length) { partes.push({}); tam = 0; }
    partes[partes.length - 1][n] = b; tam += b.length;
  }
  let env = 0;
  for (let p = 0; p < partes.length; p++) {
    const bytes = d.zip(partes[p]), nomeZip = `notas-${slugF(nomeFaz)}-${mes}${partes.length > 1 ? `-${p + 1}` : ""}.zip`;
    const leg = `🧾 <b>Fotos das notas de ${nomeMes}</b>${partes.length > 1 ? ` (arquivo ${p + 1} de ${partes.length})` : ""}\n` +
      `${nfBR(Object.keys(partes[p]).length)} fotos, numa pasta para cada parte. O nome de cada foto tem a data, o tipo de custo e o valor.` +
      (falhou && p === 0 ? `\n⚠️ ${falhou} foto(s) não foram encontradas.` : "") + `\nÉ só encaminhar ao contador junto com a planilha.`;
    for (const chat of chats) { const r = await d.envia(chat, nomeZip, bytes, leg, "application/zip"); if (r?.ok !== false) env++; }
  }
  return env;
}

/* ---------- planilha do ano para o Imposto de Renda (o contador faz a classificação) ---------- */
export async function planilhaAno(d: Deps, faz: string, ano: string, nomeFaz = "") {
  const ini = `${ano}-01-01`, fim = `${ano}-12-31`;
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const G = grupos(retirosDe(cfg?.dados)), nomeG = (g: Grupo) => g.nome || "Fazenda";
  const gastos = (await todos(d, "desembolsos", faz, ini)).filter((x) => x.data <= fim).sort(porDataG);
  const gado = (await todos(d, "movimentos", faz, ini)).filter((x) => x.data <= fim && (x.tipo === "venda" || x.tipo === "compra")).sort(porDataG);
  const soma = (a: any[]) => a.reduce((s, x) => s + (Number(x.valor) || 0), 0), inv = (x: any) => x.tipo === "investimento";
  const contas = (gs: any[], gd: any[]) => {
    const v = soma(gd.filter((x) => x.tipo === "venda")), cp = soma(gd.filter((x) => x.tipo === "compra")), cu = soma(gs.filter((x) => !inv(x))), iv = soma(gs.filter(inv));
    return [v, cp, cu, iv, v - cp - cu - iv].map(R$);
  };
  const titulo = `${nomeFaz || "Fazenda"} · ano de ${ano}`;
  const cab = ["Vendas de gado", "Compras de gado", "Custeio", "Investimento", "Saldo (vendas − compras − custeio − investimento)"];
  const resumo: any[][] = [[`Caderno da Fazenda · ${titulo}`],
    ["Totais do ano de cada parte da fazenda. A classificação para o Imposto de Renda (receita, despesa, investimento) é feita pelo contador."], [], ["Parte", ...cab]];
  G.forEach((g) => resumo.push([nomeG(g), ...contas(gastos.filter(g.f), gado.filter(g.f))]));
  if (G.length > 1) resumo.push(["Fazenda toda", ...contas(gastos, gado)]);
  const abas: Aba[] = [{ nome: "Resumo do ano", linhas: resumo, larguras: [22, 16, 16, 16, 16, 24] }];
  const detalhe = (nome: string, f: (x: any) => boolean): Aba => {
    const gs = gastos.filter(f), gd = gado.filter(f);
    const L: any[][] = [[`${nome} · ${titulo}`], [], ["MÊS A MÊS"], ["Mês", ...cab]];
    for (let m = 1; m <= 12; m++) {
      const mm = `${ano}-${String(m).padStart(2, "0")}`;
      L.push([MESF[m - 1], ...contas(gs.filter((x) => x.data.startsWith(mm)), gd.filter((x) => x.data.startsWith(mm)))]);
    }
    L.push(["Total do ano", ...contas(gs, gd)], [], ["CUSTOS POR TIPO NO ANO"], ["Tipo de custo", "Custeio", "Investimento", "Total"]);
    const its = [...new Set(gs.map((x) => (ITN[x.item] ? x.item : "outros")))].map((it) => ({ it, a: gs.filter((x) => (ITN[x.item] ? x.item : "outros") === it) }))
      .sort((p, q) => soma(q.a) - soma(p.a));
    its.forEach(({ it, a }) => L.push([ITN[it], R$(soma(a.filter((x) => !inv(x)))), R$(soma(a.filter(inv))), R$(soma(a))]));
    if (!its.length) L.push(["nenhum custo lançado no ano"]);
    L.push([], ["INVESTIMENTOS"], ["Data", "Tipo", "Descrição", "Valor (R$)", "Lançado por"]);
    const ivs = gs.filter(inv);
    ivs.forEach((x) => L.push([dBR4(x.data), ITN[x.item] || "Outros gastos", x.descricao || "", R$(x.valor), x.por || ""]));
    if (!ivs.length) L.push(["nenhum investimento lançado no ano"]);
    L.push([], ["VENDAS E COMPRAS DE GADO"], ["Data", "Tipo", "Categoria", "Cabeças", "Peso médio (kg)", "Valor (R$)", "Observação"]);
    gd.forEach((x) => L.push([dBR4(x.data), TIPOS_MOV[x.tipo], CATS[x.categoria] || "", Number(x.cab) || 0, Number(x.pesoMedio) || "", R$(x.valor), x.obs || ""]));
    if (!gd.length) L.push(["nenhuma venda ou compra de gado no ano"]);
    return { nome: nome.slice(0, 31), linhas: L, larguras: [22, 16, 16, 16, 16, 24, 20] };
  };
  if (G.length > 1) abas.push(detalhe("Fazenda toda", () => true));
  G.forEach((g) => abas.push(detalhe(nomeG(g), g.f)));
  return { abas, nCustos: gastos.length, nGado: gado.length, partes: G.map(nomeG) };
}
export async function mandaPlanilhaAno(d: Deps, faz: string, chats: number[], ano: string, nomeFaz = "") {
  if (!d.planilha || !d.envia || !chats.length) return 0;
  const P = await planilhaAno(d, faz, ano, nomeFaz), bytes = d.planilha(P.abas), parcial = ano === hojeMT().slice(0, 4);
  const legenda = `📅 <b>Planilha do ano de ${ano} para o Imposto de Renda</b>${parcial ? " (até hoje)" : ""}\n` +
    `${nfBR(P.nCustos)} custos e ${nfBR(P.nGado)} vendas/compras de gado.\n` +
    `Abas: Resumo do ano${P.partes.length > 1 ? `, Fazenda toda e uma para cada parte (${esc(P.partes.join(", "))})` : ""}, com o mês a mês, os custos por tipo, os investimentos e o gado.\n` +
    `Encaminhe ao contador: a classificação para a declaração é com ele.`;
  let n = 0;
  for (const chat of chats) { const r = await d.envia(chat, `imposto-de-renda-${slugF(nomeFaz)}-${ano}.xlsx`, bytes, legenda, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); if (r?.ok !== false) n++; }
  return n;
}
// "planilha do ano", "planilha 2025", "imposto de renda": sem dizer o ano, até maio é o ano passado (época da declaração)
export function anoPedido(cmd: string, hoje: string) {
  const m = cmd.match(/\b(20\d\d)\b/);
  return m ? m[1] : String(+hoje.slice(0, 4) - (+hoje.slice(5, 7) <= 5 ? 1 : 0));
}

/* ---------- contas a pagar (config.dados.contas): aviso na véspera e no dia, botão "Paguei" lança o custo ---------- */
export const abertas = (D: any) => (D?.contas || []).filter((c: any) => !c.paga).sort((a: any, b: any) => (a.venc < b.venc ? -1 : a.venc > b.venc ? 1 : 0));
const linhaConta = (c: any, rets: Retiro[]) => `${esc(c.descricao)} · <b>${brl(c.valor)}</b> · vence ${dBR(c.venc)}${c.mensal ? " · 🔁 todo dia " + (c.dia || +c.venc.slice(8)) : ""}${tagRet(rets, c.retiro || "")}`;
// conta mensal: o custo entra com a data do vencimento (o dia fixo do mês) e, paga, já marca a do mês seguinte
export const dataPaga = (c: any, hoje: string) => (c.mensal && okData(c.venc) ? c.venc : hoje);
export function proxConta(c: any, quem: string, porId: string) {
  if (!c.mensal || !okData(c.venc)) return null;
  const dia = Number(c.dia) || +c.venc.slice(8), [a, m] = c.venc.slice(0, 7).split("-").map(Number);
  const na = m === 12 ? a + 1 : a, nm = m === 12 ? 1 : m + 1, ult = new Date(Date.UTC(na, nm, 0)).getUTCDate();
  const venc = `${na}-${String(nm).padStart(2, "0")}-${String(Math.min(dia, ult)).padStart(2, "0")}`;
  const { paga, id, criadoEm, ...resto } = c;
  return { ...resto, id: `${crypto.randomUUID()}-b1`, venc, dia, mensal: true, de: id, porId, por: quem, criadoEm: new Date().toISOString() };
}
// lança a conta como custo (id {base}-c1, para o Desfazer) e marca como paga; devolve a conta ou o motivo
export async function pagaConta(d: Deps, conta: any, contaId: string, quem: string) {
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
  const c = (cfg?.dados?.contas || []).find((x: any) => x.id === contaId);
  if (!c) return { erro: "Essa conta não existe mais." };
  if (c.paga) return { erro: `Essa conta já foi paga em ${dBR(c.paga.data)}.` };
  const hoje = dataPaga(c, hojeMT()), base = crypto.randomUUID(), id = `${base}-c1`, item = ITN[c.item] ? c.item : "outros", centro = ONDE[c.centro] ? c.centro : "geral";
  const dados = { data: hoje, valor: c.valor, item, grupo: ITG[item], tipo: "custeio", descricao: `Conta paga: ${c.descricao}`, centro, loteId: "", contaId,
    ...(c.retiro ? { retiro: c.retiro } : {}), criadoEm: new Date().toISOString(), porId: conta.user_id, por: quem, origem: d.origem || "telegram" };
  const { error } = await d.db.from("desembolsos").insert({ id, fazenda_id: conta.fazenda_id, owner: conta.user_id, data: hoje, valor: c.valor, item, grupo: ITG[item], centro, lote_id: null, tipo: "custeio", dados });
  if (error) { console.error("pagar conta", error); return { erro: "Não consegui lançar agora. Tente de novo." }; }
  const prox = proxConta(c, quem, conta.user_id);
  await mudaCfg(d, conta.fazenda_id, (D) => ({ ...D, contas: [...(D.contas || []).map((x: any) => (x.id === contaId ? { ...x, paga: { data: hojeMT(), custo: id, base, por: quem } } : x)), ...(prox ? [prox] : [])] }));
  return { c, base, rets: retirosDe(cfg?.dados), prox };
}
// "contas": lista as contas a pagar, com botões Paguei e Cancelar
async function listaContas(d: Deps, faz: string) {
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const A = abertas(cfg?.dados), rets = retirosDe(cfg?.dados), hoje = hojeMT();
  if (!A.length) return { text: "Nenhuma conta a pagar marcada.\n\nPara marcar, mande por exemplo:\n• <i>boleto do sal R$ 4.500 vence dia 20</i>\n• <i>despesa Santa Helena: parcela do trator 3.200 vence 10/12</i>", extra: {} };
  const linhas = ["🧾 <b>Contas a pagar</b>", ...A.map((c: any, i: number) => `${i + 1}. ${linhaConta(c, rets)}${c.venc < hoje ? " ⚠️ <b>vencida</b>" : c.venc === hoje ? " ⚠️ <b>vence hoje</b>" : ""}`),
    `\nTotal: <b>${brl(A.reduce((s: number, c: any) => s + (Number(c.valor) || 0), 0))}</b>`, "Toque em ✅ quando pagar (o custo já é lançado) ou em ❌ para cancelar."];
  const kb = A.map((c: any, i: number) => [{ text: `✅ ${i + 1} paguei`, callback_data: `pago:${c.id}` }, { text: `❌ ${i + 1}`, callback_data: `canc:${c.id}` }]);
  return { text: linhas.join("\n"), extra: { reply_markup: { inline_keyboard: kb } } };
}

/* ---------- backup: todos os dados da fazenda num arquivo, pelo Telegram ---------- */
const TAB_BACKUP = ["config", "fechamentos", "movimentos", "desembolsos", "estacoes", "engorda", "insumos", "estoque_movs", "formulacoes", "adaptacoes"];
export async function geraBackup(d: Deps, faz: string) {
  const tabelas: Record<string, any[]> = {}, erros: string[] = [];
  let n = 0;
  for (const t of TAB_BACKUP) {
    const linhas: any[] = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await d.db.from(t).select("*").eq("fazenda_id", faz).range(i, i + 999);
      if (error) { console.error("backup " + t, error); erros.push(t); break; }
      linhas.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    tabelas[t] = linhas;
    if (t !== "config") n += linhas.length;
  }
  const json = JSON.stringify({ app: "Caderno da Fazenda", fazenda_id: faz, gerado_em: new Date().toISOString(), tabelas, ...(erros.length ? { faltou: erros } : {}) });
  return { bytes: new TextEncoder().encode(json), registros: n, erros };
}
async function mandaBackup(d: Deps, faz: string, chats: number[], nomeFaz: string) {
  if (!d.envia || !chats.length) return 0;
  const { bytes, registros, erros } = await geraBackup(d, faz), hoje = hojeMT();
  const slug = (nomeFaz || "fazenda").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "fazenda";
  const legenda = `🔒 <b>Backup da fazenda</b> · ${dBR(hoje)}\n${nfBR(registros)} lançamentos, mais ajustes, anotações, lembretes e pesagens.\n` +
    `Deixe este arquivo guardado aqui no Telegram. Se um dia algo sumir do app, ele traz tudo de volta.` +
    (erros.length ? `\n⚠️ Faltou: ${esc(erros.join(", "))}` : "");
  let n = 0;
  for (const chat of chats) { const r = await d.envia(chat, `backup-${slug}-${hoje}.json`, bytes, legenda); if (r?.ok !== false) n++; }
  return n;
}

/* ---------- lembretes e avisos da arroba (GitHub Actions chama ?avisos=1 às 7h e depois do pregão) ---------- */
export async function avisosDiarios(d: Deps) {
  const hoje = hojeMT();
  const { data: cfgs } = await d.db.from("config").select("fazenda_id,dados");
  const { data: contas } = await d.db.from("telegram_contas").select("chat_id,user_id,fazenda_id");
  // só usa a cotação se for recente (o arquivo do app atualiza nos dias úteis)
  let cot = d.cotacao ? await d.cotacao().catch(() => null) : null;
  if (cot && (!okData(cot.data) || dias(cot.data, hoje) > 5 || !(cot.spot > 0))) cot = null;
  let n = 0;
  for (const c of cfgs || []) {
    if (!c.fazenda_id) continue;
    const D = c.dados || {};
    const lem = (D.lembretes || []).filter((x: any) => !x.enviado && x.data <= hoje);
    const alt = cot ? (D.alertas || []).filter((a: any) => (a.direcao === "abaixo" ? cot!.spot <= a.valor : cot!.spot >= a.valor)) : [];
    const velhos = (D.lembretes || []).some((x: any) => x.enviado && dias(x.enviado, hoje) > LIMPA_ENVIADOS);
    const amanha = somaDias(hoje, 1), rets = retirosDe(D);
    const cv = abertas(D).filter((c: any) => (c.venc === amanha && !c.avisos?.v) || (c.venc <= hoje && !c.avisos?.d));
    if (!lem.length && !alt.length && !velhos && !cv.length) continue;
    const daFaz = (contas || []).filter((x: any) => x.fazenda_id === c.fazenda_id);
    // vai para quem pediu; se ele não tiver mais o Telegram ligado, vai para os outros sócios
    const para = (uid: string) => { const s = daFaz.filter((x: any) => x.user_id === uid); return (s.length ? s : daFaz).map((x: any) => x.chat_id); };
    const enviados = new Set<string>();
    for (const x of lem) {
      const t = `⏰ <b>Lembrete</b> · ${dBR(hoje)}\n${esc(x.texto)}` + (x.data < hoje ? `\n<i>era para ${dBR(x.data)}</i>` : "") + (x.por ? `\n<i>marcado por ${esc(x.por)}</i>` : "");
      const cs = para(x.porId);
      for (const chat of cs) { await d.tg("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML" }); n++; }
      if (cs.length) enviados.add(x.id);
    }
    for (const a of alt) {
      const t = `📈 <b>Arroba do boi gordo: ${brl(cot!.spot)}</b>\n${a.direcao === "abaixo" ? "Caiu abaixo" : "Passou"} de ${brl(a.valor)}, como você pediu.\n<i>B3 à vista, pregão de ${dBR(cot!.data)}. A cotação da sua região costuma ser diferente.</i>`;
      const cs = para(a.porId);
      for (const chat of cs) { await d.tg("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML" }); n++; }
      if (cs.length) enviados.add(a.id);
    }
    const avisadas: Record<string, string> = {};
    for (const k of cv) {
      const qd = k.venc === amanha ? "vence amanhã" : k.venc === hoje ? "vence hoje" : `venceu em ${dBR(k.venc)}`;
      const t = `🧾 <b>Conta ${qd}</b>\n${linhaConta(k, rets)}` + (k.por ? `\n<i>marcada por ${esc(k.por)}</i>` : "") + "\nQuando pagar, toque em Paguei: o custo já entra no app.";
      const cs = para(k.porId);
      for (const chat of cs) { await d.tg("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Paguei", callback_data: `pago:${k.id}` }]] } }); n++; }
      if (cs.length) avisadas[k.id] = k.venc === amanha ? "v" : "d";
    }
    await mudaCfg(d, c.fazenda_id, (X) => ({ ...X,
      contas: (X.contas || []).map((x: any) => (avisadas[x.id] ? { ...x, avisos: { ...(x.avisos || {}), [avisadas[x.id]]: hoje } } : x))
        .filter((x: any) => !(x.paga && dias(x.paga.data, hoje) > 120)),
      lembretes: (X.lembretes || []).map((x: any) => (enviados.has(x.id) ? { ...x, enviado: hoje } : x))
        .filter((x: any) => !(x.enviado && dias(x.enviado, hoje) > LIMPA_ENVIADOS)),
      alertas: (X.alertas || []).filter((a: any) => !enviados.has(a.id)) }));
  }
  return `${n} aviso(s) enviados`;
}
/* ---------- verde do pasto (NDVI do Sentinel-2): uma leitura por parte da fazenda a cada 5 dias ----------
   Fica em config.dados.ndvi = { parte: { g: contorno usado, at: dia da busca, al: dia do último alerta, pts: [[dia, ndvi, fração boa], ...] } }.
   Só entram leituras com pelo menos 60% da área sem nuvem. */
const VERDE_ANCORA = "2020-01-01", VERDE_PASSO = 5, VERDE_HIST = 760, VERDE_GUARDA = 1100, VERDE_BOM = 0.6;
const verdeAlinha = (s: string) => somaDias(VERDE_ANCORA, Math.floor(dias(VERDE_ANCORA, s) / VERDE_PASSO) * VERDE_PASSO);
const verdeG = (p: number[][]) => p.map((x) => x.join(",")).join(";");
const verde2 = (n: number) => n.toFixed(2).replace(".", ",");
// junta o que veio do satélite ao que já estava: a leitura nova do mesmo dia substitui a antiga; dia que ficou nublado sai
export function verdeJunta(velhos: any[], novos: { d: string; m: number; v: number }[], hoje: string) {
  const M = new Map<string, any>((velhos || []).map((p: any) => [p[0], p]));
  for (const n of novos) { if (n.v >= VERDE_BOM && Number.isFinite(n.m)) M.set(n.d, [n.d, Math.round(n.m * 1000) / 1000, Math.round(n.v * 100) / 100]); else M.delete(n.d); }
  return [...M.values()].filter((p) => dias(p[0], hoje) <= VERDE_GUARDA).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
// queda rápida: as duas últimas leituras (para uma só nublada não dar alarme falso) abaixo de 20% da média de 20 a 45 dias antes
export function verdeQueda(pts: any[]) {
  if (!pts || pts.length < 4) return null;
  const u = pts[pts.length - 1], p = pts[pts.length - 2];
  if (dias(p[0], u[0]) > 25) return null;
  const base = pts.filter((x) => { const k = dias(x[0], p[0]); return k >= 20 && k <= 45; });
  if (base.length < 2) return null;
  const ref = base.reduce((s, x) => s + x[1], 0) / base.length, alto = Math.max(u[1], p[1]);
  if (ref <= 0 || alto > ref * 0.8 || ref - alto < 0.08) return null;
  return { antes: ref, agora: u[1], pct: Math.round((1 - u[1] / ref) * 100), dia: u[0] };
}
const verdeAnoPassado = (pts: any[], dia: string) => {
  const alvo = somaDias(dia, -365); let mel: any = null, d = 11;
  for (const p of pts) { const k = Math.abs(dias(p[0], alvo)); if (k < d) { d = k; mel = p; } }
  return mel;
};
const nomeParte = (D: any, id: string) => (id === "sede" ? (D?.sede?.nome || "Sede") : retirosDe(D).find((r) => r.id === id)?.nome || id);
// busca as leituras novas e, se pedido, avisa no Telegram; forca = busca de novo mesmo já tendo buscado hoje
export async function verdeDiario(d: Deps, so?: { faz: string; forca?: boolean }) {
  if (!d.verde) return "verde: sem chaves";
  const hoje = hojeMT(), avisa = !so;
  let q = d.db.from("config").select("fazenda_id,dados");
  if (so) q = q.eq("fazenda_id", so.faz);
  const { data: cfgs } = await q;
  const { data: contas } = avisa ? await d.db.from("telegram_contas").select("chat_id,fazenda_id") : { data: [] as any[] };
  let n = 0, er = 0;
  for (const c of cfgs || []) {
    if (!c.fazenda_id) continue;
    const D = c.dados || {}, C = D.contornos || {}, N: Record<string, any> = {};
    for (const id of Object.keys(C)) {
      const poly = C[id]; if (!Array.isArray(poly) || poly.length < 3) continue;
      const g = verdeG(poly), at = D.ndvi?.[id], igual = at && at.g === g;
      const temPts = igual && at.pts?.length > 0;
      if (temPts && at.at === hoje && !so?.forca) continue;
      // contorno novo ou mudado: refaz dois anos; senão, só as últimas semanas (a imagem pode chegar atrasada)
      const de = verdeAlinha(somaDias(hoje, temPts ? -20 : -VERDE_HIST));
      let novos;
      try { novos = await d.verde.serie(poly, de, hoje); } catch (e) { console.error("verde", id, String((e as any)?.message || e)); er++; continue; }
      const pts = verdeJunta(igual ? at.pts : [], novos, hoje);
      const novo: any = { g, at: hoje, pts, diag: { lidas: novos.length, maxBons: Math.max(0, ...novos.map((x) => x.bons || 0)), total: novos[0]?.total || 0 }, ...(igual && at.al ? { al: at.al } : {}) };
      const Q = avisa ? verdeQueda(pts) : null;
      if (Q && dias(Q.dia, hoje) <= 15 && !(novo.al && dias(novo.al, hoje) < 30)) {
        const ap = verdeAnoPassado(pts, Q.dia);
        const txt = `🌾 <b>Pasto secando rápido: ${esc(nomeParte(D, id))}</b>\nO verde caiu ${Q.pct}% em cerca de um mês (de ${verde2(Q.antes)} para ${verde2(Q.agora)}). Leitura de ${dBR(Q.dia)}.` +
          (ap ? `\nNo ano passado, nesta época: ${verde2(ap[1])}.` : "") + `\n<i>O satélite mede o verde, não a quantidade de capim. Vale conferir no campo.</i>`;
        const chats = (contas || []).filter((x: any) => x.fazenda_id === c.fazenda_id);
        for (const x of chats) await d.tg("sendMessage", { chat_id: x.chat_id, text: txt, parse_mode: "HTML" });
        if (chats.length) novo.al = hoje;
      }
      N[id] = novo; n++;
    }
    if (Object.keys(N).length) {
      await mudaCfg(d, c.fazenda_id, (X) => ({ ...X, ndvi: { ...(X.ndvi || {}), ...N } }));
    }
  }
  return `verde: ${n} parte(s)${er ? `, ${er} com erro` : ""}`;
}
/* ---------- chuva estimada: mesmos períodos de 5 dias do verde, em config.dados.chuva = { parte: { g, at, pts: [[dia, mm], ...] } } ---------- */
// só entra período com os 5 dias conhecidos; o que já estava fica se a busca nova não cobrir
export function chuvaJunta(velhos: any[], diarios: { d: string; mm: number | null }[], hoje: string) {
  const G = new Map<string, number[]>();
  for (const x of diarios) { if (x.mm == null || !Number.isFinite(x.mm) || x.d > hoje) continue; const k = verdeAlinha(x.d); if (!G.has(k)) G.set(k, []); G.get(k)!.push(x.mm); }
  const M = new Map<string, any>((velhos || []).map((p: any) => [p[0], p]));
  for (const [k, v] of G) if (v.length === VERDE_PASSO) M.set(k, [k, Math.round(v.reduce((a, b) => a + b, 0) * 10) / 10]);
  return [...M.values()].filter((p) => dias(p[0], hoje) <= VERDE_GUARDA).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
export async function chuvaDiaria(d: Deps, so?: { faz: string }) {
  if (!d.chuva) return "chuva: sem fonte";
  const hoje = hojeMT();
  let q = d.db.from("config").select("fazenda_id,dados");
  if (so) q = q.eq("fazenda_id", so.faz);
  const { data: cfgs } = await q;
  let n = 0, er = 0;
  for (const c of cfgs || []) {
    if (!c.fazenda_id) continue;
    const D = c.dados || {}, C = D.contornos || {}, N: Record<string, any> = {};
    for (const id of Object.keys(C)) {
      const poly = C[id]; if (!Array.isArray(poly) || poly.length < 3) continue;
      const g = verdeG(poly), at = D.chuva?.[id], tem = at && at.g === g && at.pts?.length > 0;
      if (tem && at.at === hoje) continue;
      const la = poly.reduce((s: number, p: number[]) => s + p[0], 0) / poly.length, ln = poly.reduce((s: number, p: number[]) => s + p[1], 0) / poly.length;
      let diarios;
      try { diarios = await d.chuva(la, ln, verdeAlinha(somaDias(hoje, tem ? -25 : -VERDE_HIST)), somaDias(hoje, -1)); } catch (e) { console.error("chuva", id, String((e as any)?.message || e)); er++; continue; }
      N[id] = { g, at: hoje, pts: chuvaJunta(tem ? at.pts : [], diarios, hoje) }; n++;
    }
    if (Object.keys(N).length) await mudaCfg(d, c.fazenda_id, (X) => ({ ...X, chuva: { ...(X.chuva || {}), ...N } }));
  }
  return `chuva: ${n} parte(s)${er ? `, ${er} com erro` : ""}`;
}
/* app: POST ?verde=atualiza ou ?verde=imagem, com o login do app. O contorno vem sempre do banco, nunca do pedido. */
export async function verdeApp(d: Deps, acao: string, token: string, corpo: any): Promise<{ status: number; json: any }> {
  const uid = token && d.usuario ? await d.usuario(token) : null;
  if (!uid) return { status: 401, json: { erro: "Entre de novo no app." } };
  const fazenda = String(corpo?.fazenda || "");
  const { data: m } = await d.db.from("membros").select("user_id").eq("fazenda_id", fazenda).eq("user_id", uid).maybeSingle();
  if (!m) return { status: 403, json: { erro: "Você não é sócio desta fazenda." } };
  if (!d.verde) return { status: 503, json: { erro: "O satélite ainda não está ligado." } };
  if (acao === "atualiza") { const ok = await verdeDiario(d, { faz: fazenda }); const ch = await chuvaDiaria(d, { faz: fazenda }).catch((e) => { console.error("chuva", e); return "chuva: erro"; }); return { status: 200, json: { ok: `${ok} · ${ch}` } }; }
  if (acao !== "imagem") return { status: 400, json: { erro: "?" } };
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", fazenda).maybeSingle();
  const id = String(corpo?.parte || ""), poly = cfg?.dados?.contornos?.[id], pts = cfg?.dados?.ndvi?.[id]?.pts || [];
  if (!Array.isArray(poly) || poly.length < 3 || !pts.length) return { status: 404, json: { erro: "Ainda não há leitura desta parte." } };
  const dia = pts[pts.length - 1][0];
  try { return { status: 200, json: { png: await d.verde.imagem(poly, dia, somaDias(dia, VERDE_PASSO - 1)), dia } }; }
  catch (e) { console.error("verde imagem", String((e as any)?.message || e)); return { status: 502, json: { erro: "O satélite não respondeu. Tente de novo." } }; }
}
/* ---------- aviso de fogo: focos de calor do INPE dentro da fazenda ou a até 5 km do contorno ----------
   Só grava em config.dados.fogo quando avisa, para não mexer no banco a cada verificação.
   fogo = { parte: { t: hora do último foco avisado, dentro: se era dentro do contorno } } */
const FOGO_KM = 5, FOGO_PAUSA_H = 6, FOGO_IDADE_H = 3;
export function lerFocos(csv: string) {
  return String(csv || "").split(/\r?\n/).slice(1).flatMap((l) => {
    const [la, ln, sat, dt] = l.split(",").map((s) => s.trim());
    const lat = Number(la), lng = Number(ln), t = Date.parse(String(dt || "").replace(" ", "T") + "Z");
    return la && ln && Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(t) ? [{ lat, lng, sat: sat || "", t }] : [];
  });
}
// distância do foco até o contorno (0 se estiver dentro) e para que lado ele fica, olhando do meio da área
export function focoPerto(lat: number, lng: number, poly: number[][]) {
  const c = Math.cos(lat * Math.PI / 180), P = poly.map((p) => [(p[1] - lng) * 111.32 * c, (p[0] - lat) * 110.57]);
  let dentro = false, km = Infinity;
  P.forEach((a, i) => {
    const b = P[(i + 1) % P.length];
    if ((a[1] > 0) !== (b[1] > 0) && 0 < (b[0] - a[0]) * (0 - a[1]) / (b[1] - a[1]) + a[0]) dentro = !dentro;
    const dx = b[0] - a[0], dy = b[1] - a[1], k = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / ((dx * dx + dy * dy) || 1)));
    km = Math.min(km, Math.hypot(a[0] + k * dx, a[1] + k * dy));
  });
  const mx = P.reduce((s, p) => s + p[0], 0) / P.length, my = P.reduce((s, p) => s + p[1], 0) / P.length;
  const ang = (Math.atan2(-mx, -my) * 180 / Math.PI + 360) % 360;
  const rumo = ["norte", "nordeste", "leste", "sudeste", "sul", "sudoeste", "oeste", "noroeste"][Math.round(ang / 45) % 8];
  return { dentro, km: dentro ? 0 : km, rumo };
}
const horaMT = (ms: number) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Cuiaba", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms)).replace(", ", " às ");
// roda a cada 15 minutos (GitHub Actions chama ?fogo=1); repetir não reenvia o mesmo foco
export async function fogoVerifica(d: Deps, agora = Date.now()) {
  if (!d.focos) return "fogo: sem fonte";
  const { data: cfgs } = await d.db.from("config").select("fazenda_id,dados");
  const comContorno = (cfgs || []).filter((c: any) => c.fazenda_id && Object.values(c.dados?.contornos || {}).some((p: any) => Array.isArray(p) && p.length >= 3));
  if (!comContorno.length) return "fogo: nenhuma fazenda com contorno";
  const todos = (await d.focos()).filter((f) => agora - f.t <= FOGO_IDADE_H * 36e5);
  const { data: contas } = await d.db.from("telegram_contas").select("chat_id,fazenda_id");
  let enviados = 0;
  for (const c of comContorno) {
    const D = c.dados, linhas: string[] = [], novo: Record<string, any> = {};
    for (const id of Object.keys(D.contornos)) {
      const poly = D.contornos[id]; if (!Array.isArray(poly) || poly.length < 3) continue;
      const ant = D.fogo?.[id];
      const perto = todos.filter((f) => !(ant && f.t <= Date.parse(ant.t))).map((f) => ({ ...f, ...focoPerto(f.lat, f.lng, poly) })).filter((f) => f.km <= FOGO_KM);
      if (!perto.length) continue;
      perto.sort((a, b) => a.km - b.km);
      const f = perto[0], tem = perto.some((x) => x.dentro);
      // o mesmo fogo aparece várias vezes: depois de avisar, só repete em 6 horas ou se ele entrou na fazenda
      if (ant && agora - Date.parse(ant.t) < FOGO_PAUSA_H * 36e5 && !(tem && !ant.dentro)) continue;
      const lugares = new Set(perto.map((x) => x.lat.toFixed(2) + "," + x.lng.toFixed(2))).size;
      const onde = tem ? `<b>DENTRO da ${esc(nomeParte(D, id))}</b>` : `a cerca de <b>${f.km.toFixed(1).replace(".", ",")} km da ${esc(nomeParte(D, id))}</b>, ao ${f.rumo}`;
      linhas.push(`Foco ${onde}${lugares > 1 ? ` (${lugares} pontos)` : ""}. Visto em ${horaMT(Math.max(...perto.map((x) => x.t)))}. <a href="https://www.google.com/maps?q=${f.lat},${f.lng}">Ver no mapa</a>`);
      novo[id] = { t: new Date(Math.max(...perto.map((x) => x.t))).toISOString(), dentro: tem };
    }
    if (!linhas.length) continue;
    const chats = (contas || []).filter((x: any) => x.fazenda_id === c.fazenda_id);
    if (!chats.length) continue;
    const txt = `🔥 <b>Foco de calor perto da fazenda</b>\n${linhas.join("\n")}\n<i>O satélite vê calor: pode ser queimada de vizinho ou falso alarme, e a posição é aproximada. Confirme no local.</i>`;
    for (const x of chats) { await d.tg("sendMessage", { chat_id: x.chat_id, text: txt, parse_mode: "HTML", disable_web_page_preview: true }); enviados++; }
    await mudaCfg(d, c.fazenda_id, (X) => ({ ...X, fogo: { ...(X.fogo || {}), ...novo } }));
  }
  return `fogo: ${todos.length} foco(s) lidos, ${enviados} aviso(s)`;
}
// "lembretes": lista o que está marcado, com botão para cancelar
async function listaLembretes(d: Deps, faz: string) {
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const L = (cfg?.dados?.lembretes || []).filter((x: any) => !x.enviado).sort((a: any, b: any) => (a.data < b.data ? -1 : 1));
  const A = cfg?.dados?.alertas || [];
  if (!L.length && !A.length) return { text: "Nenhum lembrete nem aviso da arroba marcado.\n\nPara marcar, mande por exemplo:\n• <i>lembrar: vacina da aftosa dia 15/11</i>\n• <i>me avisa quando o boi passar de 320</i>", extra: {} };
  const itens = [...L, ...A];
  const linhas = [
    ...(L.length ? ["⏰ <b>Lembretes</b>", ...L.map((x: any, i: number) => `${i + 1}. ${dBR(x.data)} · ${esc(x.texto)}${x.por ? ` <i>(${esc(x.por)})</i>` : ""}`)] : []),
    ...(A.length ? [`${L.length ? "\n" : ""}📈 <b>Avisos da arroba</b>`, ...A.map((a: any, i: number) => `${L.length + i + 1}. quando o boi gordo ${a.direcao === "abaixo" ? "cair abaixo de" : "passar de"} ${brl(a.valor)}`)] : []),
    "\nPara cancelar, toque no número.",
  ];
  const bts = itens.map((x: any, i: number) => ({ text: `❌ ${i + 1}`, callback_data: `canc:${x.id}` }));
  const kb: any[][] = []; for (let i = 0; i < bts.length; i += 5) kb.push(bts.slice(i, i + 5));
  return { text: linhas.join("\n"), extra: { reply_markup: { inline_keyboard: kb } } };
}

/* ---------- perguntas sobre os dados ---------- */
export async function contexto(d: Deps, faz: string) {
  const hoje = hojeMT(), desde = somaDias(hoje, -730);
  const movs = await todos(d, "movimentos", faz), fechs = await todos(d, "fechamentos", faz), gastos = await todos(d, "desembolsos", faz, desde);
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const notas = cfg?.dados?.notas || {}, rets = retirosDe(cfg?.dados);
  const CN = (k: string) => CATS[k] || k || "";
  // parte de cada lançamento; sem retiro = Sede (fazenda principal)
  const RN = (x: any) => (rets.length ? rets.find((r) => r.id === x.retiro)?.nome || GERAL : "");
  const G: Grupo[] = [...grupos(rets).filter((g) => g.nome), { nome: "fazenda toda (total)", f: () => true }];
  const reb = G.map((g) => {
    const R: any = g.nome === "fazenda toda (total)" ? rebanhoTotal(fechs, movs, rets) : rebanhoHoje(fechs.filter(g.f), movs.filter(g.f));
    const nome = `${g.nome === "fazenda toda (total)" || g.sem ? g.nome : "retiro " + g.nome}: `;
    return R ? `${nome}total ${R.total} cabeças (fechamento de ${R.mes} + movimentos depois)` +
      (R.cats ? "; " + Object.entries(R.cats).filter(([, v]) => v).map(([k, v]) => `${CN(k)} ${v}`).join("; ") : "") : `${nome}nenhum fechamento de mês lançado ainda`;
  });
  const linhas = [
    `Hoje: ${hoje}. 1 @ = ${Number(cfg?.dados?.kgArroba) || 30} kg de peso vivo.`,
    ...(rets.length ? [`PARTES DA FAZENDA: ${rets.map((r) => r.nome).join(", ")} e ${GERAL} (a fazenda principal), cada uma com seu gado e suas contas (donos diferentes). Fazenda toda = as três somadas. Se a pergunta citar uma parte (ex.: "dados Santa Helena", "quanto gastei na Sede"), responda só com os dados dela. Se não citar, responda com a fazenda toda (tudo somado) e, se ajudar, mostre também quanto foi de cada parte.`] : []),
    "REBANHO HOJE:",
    ...reb,
    `FECHAMENTOS DO MÊS (${rets.length ? "retiro; " : ""}mês: categoria cabeças/peso médio kg):`,
    ...[...fechs].sort((a, b) => (a.mes < b.mes ? -1 : 1)).slice(-26).map((f) => (rets.length ? RN(f) + "; " : "") + `${f.mes}: ` +
      Object.entries(f.cats || {}).map(([k, v]: any) => `${CN(k)} ${v.cab}/${v.peso || "?"}kg`).join("; ")),
    "MOVIMENTOS (data;tipo;categoria;para;cabeças;peso médio kg;valor R$;obs;quem;retiro):",
    ...movs.filter((x) => x.data >= desde).sort((a, b) => (a.data < b.data ? -1 : 1)).map((x) =>
      [x.data, TIPOS_MOV[x.tipo] || x.tipo, CN(x.categoria), x.para ? CN(x.para) : "", x.cab, x.pesoMedio || "", x.valor || "", x.obs || "", x.por || "", RN(x)].join(";")),
    "CUSTOS, últimos 2 anos (data;tipo de custo;setor;valor R$;descrição;custeio ou investimento;retiro;rebanho: comercial, P.O. ou dos dois):",
    ...gastos.sort((a, b) => (a.data < b.data ? -1 : 1)).map((x) =>
      [x.data, ITN[x.item] || x.item || "", ONDE[x.centro] || "Fazenda toda", x.valor, x.descricao || "", x.tipo || "custeio", RN(x), REB[x.rebanho] || "dos dois"].join(";")),
    "BLOCO DE NOTAS (mês: texto):",
    ...Object.keys(notas).sort().slice(-12).map((m) => `${m}: ${String(notas[m]).replace(/\s*\n\s*/g, " | ")}`),
    "PESAGENS (data;lote;cabeças;peso médio kg;retiro) — GMD = diferença de peso ÷ dias entre pesagens do mesmo lote e retiro:",
    ...[...(cfg?.dados?.pesagens || [])].filter((p: any) => p.data >= desde).sort((a: any, b: any) => (a.data < b.data ? -1 : 1)).map((p: any) => [p.data, p.lote, p.cab || "", p.peso, RN(p)].join(";")),
    "LEMBRETES MARCADOS (dia;texto):",
    ...(cfg?.dados?.lembretes || []).filter((x: any) => !x.enviado).map((x: any) => `${x.data};${x.texto}`),
  ];
  return linhas.join("\n");
}
const SISTEMA_PERGUNTA = `Você responde, pelo Telegram, perguntas de um pecuarista (cria, recria e engorda em Mato Grosso) sobre os dados do caderno da fazenda dele, que vêm abaixo.
Use só esses dados. Faça as contas com cuidado (some, conte e filtre pelas datas certas). Se os dados não bastarem, diga em uma frase o que falta lançar no app.
Responda curto, em português, em texto simples: sem markdown, sem asteriscos, sem tabelas. Pode usar quebras de linha e "•" para listas. Números no formato brasileiro (1.234,50; R$ 1.234,50).`;
async function respondePergunta(d: Deps, chat: number, conta: any, pergunta: string) {
  await d.tg("sendChatAction", { chat_id: chat, action: "typing" });
  const r = await d.pensa(SISTEMA_PERGUNTA, `DADOS DA FAZENDA\n${await contexto(d, conta.fazenda_id)}\n\nPERGUNTA: ${pergunta}`);
  return responde(d, chat, r ? esc(r.trim()) : "Não consegui responder agora. Tente de novo em instantes.");
}

/* ---------- botões (Desfazer / trocar setor / trocar retiro) ---------- */
// marca com "• " o botão escolhido de uma fileira (setor ou retiro), mantendo os outros botões da mensagem
const marca = (markup: any, prefixo: string, escolhido: string) => (markup?.inline_keyboard || []).map((fila: any[]) => fila.map((b: any) =>
  String(b.callback_data || "").startsWith(prefixo) ? { ...b, text: (b.callback_data === escolhido ? "• " : "") + String(b.text).replace(/^• /, "") } : b));
async function botao(d: Deps, q: any, contaApp?: any) {
  const chat = q.message?.chat?.id, [acao, id, onde] = String(q.data || "").split(":");
  const conta = contaApp || (await d.db.from("telegram_contas").select("user_id,fazenda_id").eq("chat_id", chat).maybeSingle()).data;
  const fim = (t: string) => d.tg("answerCallbackQuery", { callback_query_id: q.id, text: t });
  if (!conta) return fim("Telegram não está ligado ao app.");
  if (acao === "desf" && /^[0-9a-f-]{36}$/.test(id)) {
    const { data: cs } = await d.db.from("desembolsos").delete().eq("fazenda_id", conta.fazenda_id).like("id", id + "-%").select("id");
    const { data: ms } = await d.db.from("movimentos").delete().eq("fazenda_id", conta.fazenda_id).like("id", id + "-%").select("id");
    const t = String(q.message?.text || ""), i = t.indexOf(MSG_ANOTA);
    const tirouNota = i >= 0 ? await desanota(d, conta, t.slice(i + MSG_ANOTA.length).split("\n")[0].trim()) : false;
    const tirou: Record<string, number> = {};
    await mudaCfg(d, conta.fazenda_id, (D) => {
      for (const k of ["lembretes", "alertas", "pesagens", "contas"]) {
        const a = D[k] || [], b = a.filter((x: any) => !String(x.id || "").startsWith(id + "-"));
        tirou[k] = a.length - b.length; if (tirou[k]) D[k] = b;
      }
      // conta paga por esta mensagem volta a ficar em aberto
      let volta = 0;
      const reab = new Set((D.contas || []).filter((x: any) => x.paga?.base === id).map((x: any) => x.id));
      D.contas = (D.contas || []).map((x: any) => (x.paga?.base === id ? (volta++, (({ paga, ...r }) => r)(x)) : x)).filter((x: any) => !(x.de && reab.has(x.de) && !x.paga));
      tirou.reabertas = volta;
      // áreas mudadas por esta mensagem voltam ao que eram
      const ad = (D.areasDesf || []).find((x: any) => x.base === id);
      if (ad) { for (const k of ["area", "areaFase", "retiros", "sede"]) { if (ad.antes[k] == null) delete D[k]; else D[k] = ad.antes[k]; }
        D.areasDesf = D.areasDesf.filter((x: any) => x.base !== id); tirou.areas = 1; }
      return Object.values(tirou).some(Boolean) ? D : null;
    });
    const nc = cs?.length || 0, nm = ms?.length || 0, pl = (n: number, um: string, v: string) => n && (n === 1 ? "1 " + um : n + " " + v);
    const partes = [pl(nc, "custo", "custos"), pl(nm, "movimento do rebanho", "movimentos do rebanho"), pl(tirou.lembretes, "lembrete", "lembretes"),
      pl(tirou.alertas, "aviso da arroba", "avisos da arroba"), pl(tirou.pesagens, "pesagem", "pesagens"), pl(tirou.contas, "conta a pagar", "contas a pagar"), pl(tirou.reabertas, "pagamento de conta (ela voltou a ficar em aberto)", "pagamentos de contas (voltaram a ficar em aberto)"), tirou.areas && "a mudança das áreas (voltaram ao que eram)", tirouNota && "a anotação"].filter(Boolean) as string[];
    if (!partes.length) return fim("Esse lançamento já não existe.");
    const lista = partes.length > 1 ? partes.slice(0, -1).join(", ") + " e " + partes.at(-1) : partes[0];
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `↩ Desfeito: tirei do app ${lista}.` });
    return fim("Desfeito");
  }
  if (acao === "ret" && /^[0-9a-f-]{36}$/.test(id) && /^[\w-]{1,20}$/.test(onde)) {
    const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
    const r = onde === "geral" ? { id: "", nome: GERAL } : retirosDe(cfg?.dados).find((x) => x.id === onde);
    if (!r) return fim("Esse retiro não existe mais.");
    const troca = (dd: any) => { const o = { ...dd }; if (r.id) o.retiro = r.id; else delete o.retiro; return o; };
    let n = 0;
    for (const tab of ["desembolsos", "movimentos"]) {
      const { data: rows } = await d.db.from(tab).select("id,dados").eq("fazenda_id", conta.fazenda_id).like("id", id + "-%");
      for (const x of rows || []) { await d.db.from(tab).update({ dados: troca(x.dados) }).eq("fazenda_id", conta.fazenda_id).eq("id", x.id); n++; }
    }
    await mudaCfg(d, conta.fazenda_id, (D) => {
      let m = 0;
      const p = (D.pesagens || []).map((x: any) => (String(x.id || "").startsWith(id + "-") ? (m++, troca(x)) : x));
      n += m; return m ? { ...D, pesagens: p } : null;
    });
    if (!n) return fim("Esse lançamento já não existe.");
    const t = String(q.message?.text || "").replace(/🏠 [^\n]*/g, "🏠 " + r.nome);
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: t,
      reply_markup: { inline_keyboard: marca(q.message.reply_markup, `ret:${id}:`, `ret:${id}:${r.id || "geral"}`) } });
    return fim(r.id ? "Agora no retiro " + r.nome : "Agora na Sede");
  }
  if (acao === "pago" && /^[0-9a-f-]{36}-b\d+$/.test(id)) {
    const { data: m } = await d.db.from("membros").select("nome,email").eq("fazenda_id", conta.fazenda_id).eq("user_id", conta.user_id).maybeSingle();
    const r: any = await pagaConta(d, conta, id, m?.nome || String(m?.email || "").split("@")[0] || "sócio");
    if (r.erro) return fim(r.erro);
    const t = String(q.message?.text || "");
    if (t.startsWith("🧾 Contas a pagar")) {
      const L = await listaContas(d, conta.fazenda_id);
      await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: L.text, parse_mode: "HTML", ...L.extra });
    } else {
      await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML",
        text: `✅ <b>Conta paga</b> · ${esc(r.c.descricao)} · <b>${brl(r.c.valor)}</b>${tagRet(r.rets, r.c.retiro || "")}\nLancei como custo de hoje no app.`, ...botoes(r.base) });
    }
    return fim("Pago e lançado como custo");
  }
  if (acao === "canc" && /^[0-9a-f-]{36}-[lab]\d+$/.test(id)) {
    let achou = false;
    await mudaCfg(d, conta.fazenda_id, (D) => {
      for (const k of ["lembretes", "alertas", "contas"]) {
        const a = D[k] || [], b = a.filter((x: any) => x.id !== id);
        if (b.length !== a.length) { D[k] = b; achou = true; }
      }
      return achou ? D : null;
    });
    const L = /-b\d+$/.test(id) ? await listaContas(d, conta.fazenda_id) : await listaLembretes(d, conta.fazenda_id);
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: L.text, parse_mode: "HTML", ...L.extra });
    return fim(achou ? "Cancelado" : "Já não estava marcado.");
  }
  // botões de mensagens antigas (antes de juntar tudo numa mensagem)
  if (acao === "apagarm" && /^[0-9a-f-]{36}$/.test(id)) {
    const { data: ms } = await d.db.from("movimentos").delete().eq("fazenda_id", conta.fazenda_id).like("id", id + "-%").select("id");
    if (!ms?.length) return fim("Esse lançamento já não existe.");
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `↩ Desfeito: ${ms.length > 1 ? ms.length + " movimentos saíram" : "o movimento saiu"} do rebanho no app.` });
    return fim("Lançamento apagado");
  }
  const { data: x } = await d.db.from("desembolsos").select("dados").eq("fazenda_id", conta.fazenda_id).eq("id", id).maybeSingle();
  if (!x) return fim("Esse lançamento já não existe.");
  if (acao === "apagar") {
    await d.db.from("desembolsos").delete().eq("fazenda_id", conta.fazenda_id).eq("id", id);
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML", text: `↩ Desfeito: ${esc(ITN[x.dados.item] || "custo")} · ${brl(+x.dados.valor || 0)} não está mais no app.` });
    return fim("Lançamento apagado");
  }
  if (acao === "onde" && ONDE[onde]) {
    await d.db.from("desembolsos").update({ centro: onde, dados: { ...x.dados, centro: onde } }).eq("fazenda_id", conta.fazenda_id).eq("id", id);
    const t = String(q.message.text || "").replace(/· (Fazenda toda|Cria|Recria|Engorda)\b/, "· " + ONDE[onde]);
    const kb = { reply_markup: { inline_keyboard: marca(q.message.reply_markup, `onde:${id}:`, `onde:${id}:${onde}`) } };
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: t, ...kb });
    return fim("Agora em: " + ONDE[onde]);
  }
  return fim("");
}

/* ---------- mensagem ---------- */
export async function trata(d: Deps, up: any) {
  if (up.update_id != null) {
    const { error } = await d.db.from("telegram_updates").insert({ update_id: up.update_id });
    if (error) return; // já tratada (o Telegram reenviou)
  }
  if (up.callback_query) return botao(d, up.callback_query);
  const msg = up.message; if (!msg?.chat?.id) return;
  const chat = msg.chat.id, nomeTg = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  let texto = String(msg.text || msg.caption || "").trim();
  const cod = texto.match(/^(?:\/start\s+)?(\d{8})$/);
  if (cod) return liga(d, chat, cod[1], nomeTg);
  const { data: conta } = await d.db.from("telegram_contas").select("user_id,fazenda_id").eq("chat_id", chat).maybeSingle();
  if (!conta) return responde(d, chat, "Olá! Para usar o robô, ligue seu Telegram pelo app: <b>Mais → Sócios → Conectar meu Telegram</b>. Depois mande aqui o código de 6 números.");
  if (/^\/(start|ajuda|help)\b/i.test(texto)) return responde(d, chat, AJUDA);
  const { data: m } = await d.db.from("membros").select("nome,email").eq("fazenda_id", conta.fazenda_id).eq("user_id", conta.user_id).maybeSingle();
  if (!m) return responde(d, chat, "Você não faz mais parte desta fazenda no app. Peça para um sócio te convidar de novo.");
  const quem = m.nome || String(m.email || "").split("@")[0] || nomeTg || "sócio";

  // áudio: vira texto e segue igual a uma mensagem escrita
  const audio = msg.voice || msg.audio;
  if (audio) {
    if (!d.transcreve) return responde(d, chat, "Ainda não entendo áudio: falta ligar a transcrição (chave da OpenAI). Por enquanto, mande por escrito.");
    if ((audio.duration || 0) > 180) return responde(d, chat, "Áudio muito longo. Mande áudios de até 3 minutos.");
    const f = await d.tg("getFile", { file_id: audio.file_id });
    if (!f?.ok) return responde(d, chat, "Não consegui baixar o áudio. Tente mandar de novo.");
    await d.tg("sendChatAction", { chat_id: chat, action: "typing" });
    const ext = (String(f.result.file_path).match(/\.(\w+)$/)?.[1] || "ogg").replace(/^oga$/, "ogg");
    const ouvido = (await d.transcreve(await d.baixa(f.result.file_path), `audio.${ext}`))?.trim();
    if (!ouvido) return responde(d, chat, "Não consegui entender o áudio. Tente de novo falando mais perto do celular, ou mande por escrito.");
    await responde(d, chat, `🎤 <i>${esc(ouvido)}</i>`);
    texto = ouvido;
  }
  return trataTexto(d, chat, conta, quem, texto, msg, !!audio);
}

// texto (escrito, falado no Telegram ou falado no microfone do app): comandos, anotação, pergunta ou lançamento
async function trataTexto(d: Deps, chat: number, conta: any, quem: string, texto: string, msg: any, audio: boolean) {
  // comandos que não gastam com a inteligência artificial
  const cmd = texto.toLowerCase().replace(/[.!?]+$/, "").trim();
  if (!msg.photo && !msg.document && /^\/?(meus |ver )?(lembretes|avisos|alertas)$/.test(cmd)) {
    const L = await listaLembretes(d, conta.fazenda_id);
    return responde(d, chat, L.text, L.extra);
  }
  if (!msg.photo && !msg.document && /^\/?(manda o |mandar o |quero o |ver o )?relat[oó]rio( mensal| do m[eê]s( passado)?)?$/.test(cmd)) {
    await d.tg("sendChatAction", { chat_id: chat, action: "typing" });
    await relatorioMensal(d, { faz: conta.fazenda_id, chat });
    return;
  }
  if (!msg.photo && !msg.document && /^\/?(minhas |ver as |ver )?contas( a pagar)?$/.test(cmd)) {
    const L = await listaContas(d, conta.fazenda_id);
    return responde(d, chat, L.text, L.extra);
  }
  if (!msg.photo && !msg.document && cmd.length < 50 && (/^\/?(manda a |mandar a |quero a )?planilha (do ano|anual|de 20\d\d|20\d\d)/.test(cmd) || /^\/?(planilha (do |para o )?)?imposto de renda/.test(cmd))) {
    if (!d.planilha || !d.envia) return responde(d, chat, "A planilha ainda não está ligada.");
    await d.tg("sendChatAction", { chat_id: chat, action: "upload_document" });
    const { data: fz } = await d.db.from("fazendas").select("nome").eq("id", conta.fazenda_id).maybeSingle();
    const n = await mandaPlanilhaAno(d, conta.fazenda_id, [chat], anoPedido(cmd, hojeMT()), fz?.nome || "");
    return n ? undefined : responde(d, chat, "Não consegui gerar a planilha agora. Tente de novo em instantes.");
  }
  if (!msg.photo && !msg.document && cmd.length < 50 && /^\/?(manda as |mandar as |quero as )?(fotos d[aeo]s? )?notas( fiscais)?\b/.test(cmd)) {
    if (!d.zip || !d.envia) return responde(d, chat, "As fotos das notas ainda não estão ligadas.");
    await d.tg("sendChatAction", { chat_id: chat, action: "upload_document" });
    const { data: fz } = await d.db.from("fazendas").select("nome").eq("id", conta.fazenda_id).maybeSingle();
    await mandaNotas(d, conta.fazenda_id, [chat], mesPedido(cmd, hojeMT()), fz?.nome || "", true);
    return;
  }
  if (!msg.photo && !msg.document && /^\/?(manda a |mandar a |quero a )?planilha\b/.test(cmd) && cmd.length < 50) {
    if (!d.planilha || !d.envia) return responde(d, chat, "A planilha ainda não está ligada.");
    await d.tg("sendChatAction", { chat_id: chat, action: "upload_document" });
    const { data: fz } = await d.db.from("fazendas").select("nome").eq("id", conta.fazenda_id).maybeSingle();
    const n = await mandaPlanilha(d, conta.fazenda_id, [chat], mesPedido(cmd, hojeMT()), fz?.nome || "");
    return n ? undefined : responde(d, chat, "Não consegui gerar a planilha agora. Tente de novo em instantes.");
  }
  if (!msg.photo && !msg.document && /^\/?(fazer |quero o |manda o |mandar o )?backup$/.test(cmd)) {
    if (!d.envia) return responde(d, chat, "O backup ainda não está ligado.");
    await d.tg("sendChatAction", { chat_id: chat, action: "upload_document" });
    const { data: fz } = await d.db.from("fazendas").select("nome").eq("id", conta.fazenda_id).maybeSingle();
    const n = await mandaBackup(d, conta.fazenda_id, [chat], fz?.nome || "");
    return n ? undefined : responde(d, chat, "Não consegui gerar o backup agora. Tente de novo em instantes.");
  }

  // anotação direta, sem gastar com a inteligência artificial
  // (no áudio a transcrição costuma escrever "Anotar, ..." ou "Anota ...")
  const an = texto.match(/^(?:anotar|anota|nota)\s*[:\-]\s*([\s\S]+)/i) || (audio ? texto.match(/^(?:anotar|anota)(?:\s*[,.:\-]\s*|\s+)([\s\S]+)/i) : null);
  if (an && !msg.photo && !msg.document) return lancaNota(d, chat, conta, quem, an[1]);

  // pergunta direta (termina com "?"): não precisa classificar antes
  if (texto.endsWith("?") && !msg.photo && !msg.document) return respondePergunta(d, chat, conta, texto);

  const conteudo: any[] = [];
  const foto = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
  const doc = msg.document && /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(msg.document.mime_type || "") ? msg.document : null;
  let arquivo: Uint8Array | null = null, tipoArq = "";
  if (foto || doc) {
    const f = await d.tg("getFile", { file_id: (foto || doc).file_id });
    if (!f?.ok) return responde(d, chat, "Não consegui baixar o arquivo. Tente mandar de novo.");
    arquivo = await d.baixa(f.result.file_path);
    tipoArq = doc ? doc.mime_type : "image/jpeg";
    const dados = b64(arquivo);
    conteudo.push(tipoArq === "application/pdf" ? { type: "document", source: { type: "base64", media_type: tipoArq, data: dados } }
      : { type: "image", source: { type: "base64", media_type: tipoArq, data: dados } });
  } else if (!texto) {
    return responde(d, chat, AJUDA);
  }
  const { data: cfgT } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
  const retsT = retirosDe(cfgT?.dados);
  const abT = abertas(cfgT?.dados);
  conteudo.push({ type: "text", text: `Hoje é ${hojeMT()}.` + (retsT.length ? `\nPartes da fazenda: ${[...retsT.map((r) => r.nome), GERAL].join(", ")}.` : "") +
    (abT.length ? `\nContas a pagar marcadas: ${abT.map((c: any, i: number) => `${i + 1}) ${c.descricao} · R$ ${c.valor} · vence ${c.venc}`).join("; ")}.` : "") +
    (texto ? `\nMensagem: ${texto}` : "\n(só a imagem)") });
  await d.tg("sendChatAction", { chat_id: chat, action: "typing" });
  const L = await d.le(conteudo);
  if (!L) return responde(d, chat, "Não consegui ler agora. Tente de novo em instantes ou lance pelo app.");
  if (L.tipo === "pergunta" && texto) return respondePergunta(d, chat, conta, texto);
  const temCusto = (L.custos || []).some((c) => Number(c.valor) > 0);
  return lanca(d, chat, conta, quem, L, arquivo && temCusto ? await guardaNota(d, conta.fazenda_id, arquivo, tipoArq) : "");
}

/* ---------- servidor ---------- */
if (typeof Deno !== "undefined") {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  // a chave foi salva no Supabase como ANTHOPIC_API_KEY (sem o R); aceita os dois nomes
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("ANTHOPIC_API_KEY") });
  // chave de serviço: a antiga (SUPABASE_SERVICE_ROLE_KEY) ou a nova (SUPABASE_SECRET_KEYS, um JSON {"default": "sb_secret_..."})
  const chaveServico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    (() => { try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return k.default || Object.values(k)[0] || ""; } catch { return ""; } })();
  const db = createClient(Deno.env.get("SUPABASE_URL")!, chaveServico as string, { auth: { persistSession: false } });
  const tg = async (metodo: string, corpo: Record<string, unknown>) =>
    (await fetch(`https://api.telegram.org/bot${token}/${metodo}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) })).json();
  const baixa = async (caminho: string) => new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${token}/${caminho}`)).arrayBuffer());
  const le = async (conteudo: any[]): Promise<Leitura | null> => {
    try {
      const r = await anthropic.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default", // se o modelo recusar por engano, o próprio servidor tenta outro
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        system: SISTEMA,
        messages: [{ role: "user", content: conteudo }],
      } as any);
      if (r.stop_reason === "refusal") { console.error("recusa", (r as any).stop_details); return null; }
      const t = r.content.find((b: any) => b.type === "text") as any;
      return t ? JSON.parse(t.text) : null;
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) console.error("ANTHROPIC_API_KEY inválida");
      else if (e instanceof Anthropic.RateLimitError) console.error("limite da API do Claude");
      else if (e instanceof Anthropic.APIError) console.error(`erro da API do Claude ${e.status}:`, e.message);
      else console.error("erro ao ler", e);
      return null;
    }
  };
  const pensa = async (sistema: string, texto: string): Promise<string | null> => {
    try {
      const r = await anthropic.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" }, // contas com os dados: um pouco mais de cuidado
        system: sistema,
        messages: [{ role: "user", content: texto }],
      } as any);
      if (r.stop_reason === "refusal") { console.error("recusa", (r as any).stop_details); return null; }
      return r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || null;
    } catch (e) {
      console.error("erro ao responder pergunta", e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
      return null;
    }
  };
  // fotos das notas: pasta privada "notas" do Storage (criada na primeira vez); só a função lê e grava
  const guarda = async (caminho: string, bytes: Uint8Array, tipo: string) => {
    const sobe = () => db.storage.from("notas").upload(caminho, bytes, { contentType: tipo, upsert: false });
    let { error } = await sobe();
    if (error && /not.?found/i.test(error.message)) {
      await db.storage.createBucket("notas", { public: false, fileSizeLimit: 10 * 1024 * 1024 });
      ({ error } = await sobe());
    }
    if (error) console.error("guardar nota", error);
    return !error;
  };
  const link = async (caminho: string) => {
    const { data, error } = await db.storage.from("notas").createSignedUrl(caminho, 3600);
    if (error) console.error("link nota", error);
    return data?.signedUrl || null;
  };
  const usuario = async (jwt: string) => { const { data } = await db.auth.getUser(jwt); return data?.user?.id || null; };
  // áudio → texto pela OpenAI (segredo OPENAI_API_KEY); sem a chave, o robô avisa que ainda não entende áudio
  const chaveOpenAI = Deno.env.get("OPENAI_API_KEY") || "";
  const transcreve = chaveOpenAI ? async (bytes: Uint8Array, nome: string) => {
    try {
      const fd = new FormData();
      fd.append("file", new Blob([bytes]), nome);
      fd.append("model", "gpt-4o-mini-transcribe");
      fd.append("language", "pt");
      fd.append("prompt", "Pecuária de corte em Mato Grosso. Palavras comuns: bezerros, matrizes, vacas, novilhas, garrotes, boi gordo, boi magro, arroba, desmama, IATF, DDG, núcleo, sal mineral, proteinado, cria, recria, engorda, confinamento, TIP, diesel. Valores em reais.");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${chaveOpenAI}` }, body: fd });
      if (!r.ok) { console.error("transcrição", r.status, await r.text()); return null; }
      return (await r.json()).text ?? null; // "" = não deu para entender; null = erro
    } catch (e) { console.error("transcrição", e); return null; }
  } : undefined;
  const envia = async (chat: number, nome: string, bytes: Uint8Array, legenda: string, tipo = "application/json") => {
    const fd = new FormData();
    fd.append("chat_id", String(chat)); fd.append("caption", legenda); fd.append("parse_mode", "HTML");
    fd.append("document", new Blob([bytes], { type: tipo }), nome);
    const r = await (await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: fd })).json();
    if (!r?.ok) console.error("sendDocument", r);
    return r;
  };
  // mesma cotação que o app mostra (o GitHub atualiza cotacoes.json nos dias úteis)
  const cotacao = async () => {
    const r = await fetch("https://raw.githubusercontent.com/drhigorfreitas-design/caderno-da-fazenda/main/cotacoes.json", { cache: "no-store" });
    if (!r.ok) return null;
    const b = (await r.json())?.boi;
    return b?.spot > 0 && b?.data ? { data: String(b.data), spot: Number(b.spot) } : null;
  };
  // planilha Excel: valores { $: n } viram número com formato de reais
  const planilha = (abas: Aba[]) => {
    const wb = XLSX.utils.book_new();
    for (const a of abas) {
      const moeda: string[] = [];
      const linhas = a.linhas.map((l, r) => l.map((v, c) => { if (v && typeof v === "object" && "$" in v) { moeda.push(XLSX.utils.encode_cell({ r, c })); return v.$; } return v; }));
      const ws = XLSX.utils.aoa_to_sheet(linhas);
      moeda.forEach((ref) => { if (ws[ref]) ws[ref].z = '"R$" #,##0.00'; });
      ws["!cols"] = a.larguras.map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(wb, ws, a.nome);
    }
    return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  };
  const baixaNota = async (caminho: string) => {
    const { data, error } = await db.storage.from("notas").download(caminho);
    if (error || !data) { console.error("baixar nota", caminho, error); return null; }
    return new Uint8Array(await data.arrayBuffer());
  };
  // fotos já são comprimidas: guarda sem comprimir de novo (mais rápido)
  const zip = (arquivos: Record<string, Uint8Array>) => zipSync(Object.fromEntries(Object.entries(arquivos).map(([n, b]) => [n, [b, { level: 0 }]])) as any);
  const admin = {
    ver: async (id: string) => { const { data, error } = await db.auth.admin.getUserById(id); if (error) console.error("ver usuário", error); return data?.user || null; },
    criar: async (email: string, senha: string, meta: Record<string, unknown>) => {
      const { data, error } = await db.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: meta });
      if (error) console.error("criar usuário", error.message);
      return error ? { erro: error.message } : { id: data.user?.id };
    },
    atualizar: async (id: string, attrs: Record<string, unknown>) => { const { error } = await db.auth.admin.updateUserById(id, attrs as any); if (error) console.error("atualizar usuário", error); return !error; },
  };
  // satélite (Copernicus): o token dura uns 10 minutos; pedir muitos é limitado, então reaproveita
  const cdseId = Deno.env.get("CDSE_CLIENT_ID") || "", cdseSegredo = Deno.env.get("CDSE_CLIENT_SECRET") || "";
  let cdseTok = { v: "", ate: 0 };
  const cdseToken = async () => {
    if (cdseTok.v && Date.now() < cdseTok.ate) return cdseTok.v;
    const r = await fetch("https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: cdseId, client_secret: cdseSegredo }) });
    if (!r.ok) throw new Error("token do satélite: " + r.status);
    const j = await r.json();
    cdseTok = { v: j.access_token, ate: Date.now() + (Number(j.expires_in || 300) - 60) * 1000 };
    return cdseTok.v;
  };
  // contorno: [lat,lng] no app; o satélite pede [lng,lat] com o anel fechado
  const geo = (p: number[][]) => ({ type: "Polygon", coordinates: [[...p, p[0]].map(([la, ln]) => [ln, la])] });
  // tamanho em pixels para ficar perto de 10 m por pixel
  const pixels = (p: number[][], max = 2000) => {
    const la = p.map((x) => x[0]), ln = p.map((x) => x[1]), meio = (Math.min(...la) + Math.max(...la)) / 2;
    const h = (Math.max(...la) - Math.min(...la)) * 110574, w = (Math.max(...ln) - Math.min(...ln)) * 111320 * Math.cos(meio * Math.PI / 180);
    const k = Math.min(1, max / (Math.max(w, h) / 10));
    return { width: Math.max(8, Math.round(w / 10 * k)), height: Math.max(8, Math.round(h / 10 * k)) };
  };
  const RUIM = "[0,1,3,6,7,8,9,10,11]"; // sem dado, saturado, sombra, água, indefinido, nuvens, cirrus, neve
  const EV_SERIE = `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","SCL","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){var t=s.B08+s.B04,ok=s.dataMask===1&&t>0&&${RUIM}.indexOf(s.SCL)<0;return{data:[t>0?(s.B08-s.B04)/t:0],dataMask:[ok?1:0]}}`;
  const EV_IMAGEM = `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","SCL","dataMask"]}],output:{bands:4}}}
var C=[[0.1,[150,90,50]],[0.3,[205,165,85]],[0.5,[225,220,110]],[0.7,[110,180,70]],[0.9,[20,110,50]]];
function cor(n){if(n<=C[0][0])return C[0][1];for(var i=1;i<C.length;i++){if(n<=C[i][0]){var a=C[i-1],b=C[i],k=(n-a[0])/(b[0]-a[0]);return[0,1,2].map(function(j){return a[1][j]+(b[1][j]-a[1][j])*k})}}return C[C.length-1][1]}
function evaluatePixel(s){var t=s.B08+s.B04,ok=s.dataMask===1&&t>0&&${RUIM}.indexOf(s.SCL)<0;var c=cor(t>0?(s.B08-s.B04)/t:0);return[c[0]/255,c[1]/255,c[2]/255,ok?1:0]}`;
  const verde: Deps["verde"] = cdseId && cdseSegredo ? {
    serie: async (poly, de, ate) => {
      const r = await fetch("https://sh.dataspace.copernicus.eu/statistics/v1", { method: "POST", headers: { authorization: `Bearer ${await cdseToken()}`, "content-type": "application/json" }, body: JSON.stringify({
        input: { bounds: { geometry: geo(poly) }, data: [{ type: "sentinel-2-l2a", dataFilter: { mosaickingOrder: "leastCC" } }] },
        aggregation: { timeRange: { from: de + "T00:00:00Z", to: ate + "T23:59:59Z" }, aggregationInterval: { of: "P5D", lastIntervalBehavior: "SHORTEN" }, ...pixels(poly), evalscript: EV_SERIE },
      }) });
      if (!r.ok) throw new Error(`satélite ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      // o contorno ocupa só parte do retângulo que a API lê
      const la = poly.map((x) => x[0]), ln = poly.map((x) => x[1]);
      const area = Math.abs(poly.reduce((s, x, i) => { const y = poly[(i + 1) % poly.length]; return s + x[1] * y[0] - y[1] * x[0]; }, 0)) / 2;
      const cheio = area / ((Math.max(...la) - Math.min(...la)) * (Math.max(...ln) - Math.min(...ln)));
      return (j.data || []).flatMap((x: any) => {
        const st = x.outputs?.data?.bands?.B0?.stats; if (!st || !(st.sampleCount > 0)) return [];
        const bons = st.sampleCount - st.noDataCount;
        return [{ d: String(x.interval.from).slice(0, 10), m: Number(st.mean), v: Math.min(1, bons / (st.sampleCount * cheio)), bons, total: st.sampleCount }];
      });
    },
    imagem: async (poly, de, ate) => {
      const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/process", { method: "POST", headers: { authorization: `Bearer ${await cdseToken()}`, "content-type": "application/json", accept: "image/png" }, body: JSON.stringify({
        input: { bounds: { geometry: geo(poly) }, data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: de + "T00:00:00Z", to: ate + "T23:59:59Z" }, mosaickingOrder: "leastCC" } }] },
        output: { ...pixels(poly, 1024), responses: [{ identifier: "default", format: { type: "image/png" } }] }, evalscript: EV_IMAGEM,
      }) });
      if (!r.ok) throw new Error(`satélite ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return b64(new Uint8Array(await r.arrayBuffer()));
    },
  } : undefined;
  // chuva estimada por modelo do tempo (Open-Meteo, grátis para app privado sem assinatura nem anúncio; licença CC BY 4.0)
  const chuva = async (lat: number, lng: number, de: string, ate: string) => {
    const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&start_date=${de}&end_date=${ate}&daily=precipitation_sum&timezone=America%2FCuiaba`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    const j = await r.json();
    return (j.daily?.time || []).map((d: string, i: number) => ({ d, mm: j.daily.precipitation_sum[i] }));
  };
  // focos de calor: o INPE publica um arquivo a cada 10 minutos; lê os últimos 9 (cerca de hora e meia)
  const INPE = "https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/10min/";
  const focos = async () => {
    const r = await fetch(INPE, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("INPE " + r.status);
    const nomes = [...new Set((await r.text()).match(/focos_10min_\d{8}_\d{4}\.csv/g) || [])].sort().slice(-9);
    if (!nomes.length) throw new Error("INPE sem arquivos");
    const textos = await Promise.all(nomes.map((n) => fetch(INPE + n, { signal: AbortSignal.timeout(20000) }).then((x) => (x.ok ? x.text() : "")).catch(() => "")));
    return textos.flatMap(lerFocos);
  };
  const deps: Deps = { token, tg, baixa, le, pensa, db, guarda, link, usuario, transcreve, envia, cotacao, planilha, baixaNota, zip, admin, verde, focos, chuva };
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, apikey, x-client-info", "access-control-allow-methods": "POST, OPTIONS" };

  Deno.serve(async (req) => {
    const url = new URL(req.url), segredo = await segredoWebhook(token);
    if (url.searchParams.has("setup")) {
      // liga o webhook do Telegram nesta função (abrir uma vez no navegador)
      if (!token) return new Response("Falta o segredo TELEGRAM_BOT_TOKEN.", { status: 500 });
      const alvo = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram`;
      const r = await tg("setWebhook", { url: alvo, secret_token: segredo, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
      const eu = await tg("getMe", {});
      return new Response(r.ok ? `Robô @${eu.result?.username} ligado. Pode fechar esta página.` : "Erro: " + JSON.stringify(r), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.searchParams.has("nota")) {
      // chamado pelo app (formulário de custo): guarda a foto e, se pedido, lê a nota
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      let r = { status: 500, json: { erro: "Erro no servidor. Tente de novo." } as any };
      try {
        const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        r = await notaApp(deps, url.searchParams.get("nota") || "", jwt, await req.json());
      } catch (e) { console.error("nota", e); }
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
    }
    if (url.searchParams.has("acesso")) {
      // chamado pelo app (Sócios → Gerenciar acessos): só o dono da fazenda
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      let r = { status: 500, json: { erro: "Erro no servidor. Tente de novo." } as any };
      try {
        const jwt = (req.headers.get("authorization") || "").replace(/^Bearers+/i, "");
        r = await acessoApp(deps, url.searchParams.get("acesso") || "", jwt, await req.json());
      } catch (e) { console.error("acesso", e); }
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
    }
    if (url.searchParams.has("voz")) {
      // chamado pelo app (botão do microfone): o texto falado é lançado igual a uma mensagem do Telegram
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      let r = { status: 500, json: { erro: "Erro no servidor. Tente de novo." } as any };
      try {
        const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        r = await vozApp(deps, url.searchParams.get("voz") || "", jwt, await req.json());
      } catch (e) { console.error("voz", e); }
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
    }
    if (url.searchParams.has("fogo")) {
      // chamado a cada 15 minutos pelo GitHub Actions; repetir não reenvia o mesmo foco
      try { return new Response(await fogoVerifica(deps)); } catch (e) { console.error("fogo", e); return new Response("fogo: fonte fora do ar"); }
    }
    if (url.searchParams.has("verde")) {
      // chamado pelo app (aba Mapa): busca as leituras depois de salvar um contorno, ou a imagem do verde
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      let r = { status: 500, json: { erro: "Erro no servidor. Tente de novo." } as any };
      try {
        const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        r = await verdeApp(deps, url.searchParams.get("verde") || "", jwt, await req.json());
      } catch (e) { console.error("verde", e); }
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
    }
    if (url.searchParams.has("resumo")) {
      // chamado toda segunda pelo GitHub Actions; manda no máximo uma vez por semana
      try { return new Response(await resumoSemanal(deps)); } catch (e) { console.error("resumo", e); return new Response("erro", { status: 500 }); }
    }
    if (url.searchParams.has("avisos")) {
      // chamado todo dia pelo GitHub Actions: lembretes do dia e avisos de preço da arroba
      // no dia 1º, manda antes o relatório do mês que acabou
      let mensal = "";
      try { mensal = await relatorioMensal(deps); } catch (e) { console.error("relatório mensal", e); mensal = "erro no relatório mensal"; }
      // o verde do pasto vai junto; se o satélite falhar, os lembretes já saíram
      let txtVerde = "";
      try { const av = await avisosDiarios(deps); try { txtVerde = await verdeDiario(deps); } catch (e) { console.error("verde", e); txtVerde = "erro no verde"; } let txtChuva = ""; try { txtChuva = await chuvaDiaria(deps); } catch (e) { console.error("chuva", e); txtChuva = "erro na chuva"; } return new Response(`${av} · ${mensal} · ${txtVerde} · ${txtChuva}`); } catch (e) { console.error("avisos", e); return new Response("erro", { status: 500 }); }
    }
    if (req.method !== "POST" || req.headers.get("x-telegram-bot-api-secret-token") !== segredo) return new Response("ok");
    try { await trata(deps, await req.json()); } catch (e) { console.error("falha", e); }
    return new Response("ok");
  });
}
