// Страница поставщика (T-543). Слева, сразу после основного меню, — своя колонка, как колонка фильтров в списках:
// «← категория», кто это, меню разделов («Основное · Разбор · Условия · Документы · Ассортимент»), на «Разборе» — «Что важнее».
// Справа — шапка с баллом и раздел. «Основное» — плашки: виджеты разделов слева, компания, контакты, отзывы, заметки справа;
// остальные разделы — во всю ширину, без плашек (правка Павла 15.10). Раздел — в адресе (?tab=…).
// На телефоне колонка, как у фильтров, встаёт над шапкой, а меню разделов — полосой вкладок, которая прилипает под меню.
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { href, navigate, paramsToObject, type Route } from "../router.ts";
import { actions, CONTACT_STATUSES, useStore, type ContactStatus } from "../store.ts";
import { byId, catById, CATEGORIES, categoryOf, inCategory, queryParams, rankCategory, readQuery, subsIn, volParam } from "../data.ts";
import { asks } from "../lib/explain.ts";
import { completeness, CRITS, fnsFlags, PRIORITIES, profileDeclarations, score, stopReason, type Priority } from "../lib/score.ts";
import { ageYears, dateRu, isKnown, minOrderText, monthYear, num, plural, years } from "../lib/format.ts";
import { level } from "../lib/level.ts";
import { logoOf } from "../lib/logos.ts";
import { avgText, mergeStat, useReviewStat, type ReviewStat } from "../lib/reviewStats.ts";
import type { Category, FieldStatus, Hours, Supplier } from "../types.ts";
import { Avatar, CatGlyph, DemoPill, DocGlyph, FillBar, Hint, ReviewBadge, Rule, StarButton, Stars, StatusIcon } from "../components/ui.tsx";
import { deliveryShort, deliveryText, FieldRow, GuestTag, PRICE_MODE, SourceLinks, sourceLabel } from "../components/supplier.tsx";
import { Breakdown, PrioSwitch, type Place } from "../components/Breakdown.tsx";
import { Railed } from "../components/FilterRail.tsx";
import { Footer } from "../components/Footer.tsx";
import type { Reviews as ReviewList } from "../lib/api.ts";
import { ReviewsDrawer, useSupplierReviews } from "../components/ReviewsDrawer.tsx";

const TAX = { general: "общий — счета с НДС", usn: "УСН — без НДС" } as const;
const PRESENCE = { warehouse: "склад в городе", delivery_only: "без склада в городе", unknown: "не известно" } as const;

export type Tab = "main" | "why" | "terms" | "docs" | "assortment";
const TAB_LABEL: Record<Tab, string> = { main: "Основное", why: "Разбор", terms: "Условия", docs: "Документы", assortment: "Ассортимент" };
/** Состав разделов — выбор Павла на показе 15.10 (вариант из двух: без «Условий» и «Документов» отдельными разделами). */
const TABS: Tab[] = ["main", "why", "terms", "docs", "assortment"];

// Линейные значки 18 px — как в основном меню: у каждого раздела свой силуэт.
const TAB_ICONS: Record<Tab, ReactNode> = {
  main: <><rect x="2.5" y="3" width="13" height="12" rx="3" /><path d="M5.5 7h7M5.5 10.5h4.5" /></>,
  why: <path d="M3.5 15.5v-5M7.5 15.5V4.5M11.5 15.5V8M15.5 15.5V2.5" />,
  terms: <><path d="M1.5 4.5h9v7.5h-9zM10.5 7h3.6l2.4 2.6V12h-6" /><circle cx="5" cy="13.6" r="1.5" /><circle cx="13" cy="13.6" r="1.5" /></>,
  docs: <><path d="M4.5 2h6l3.5 3.5V16h-9.5z" /><path d="M10.5 2v3.5H14M7 9h4.5M7 12h4.5" /></>,
  assortment: <><path d="M9 2.5l6.5 3v7L9 15.5l-6.5-3v-7z" /><path d="M2.5 5.5 9 8.5l6.5-3M9 8.5v7" /></>,
};
const TabIcon = ({ t }: { t: Tab }) => (
  <svg className="nav-ic" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">{TAB_ICONS[t]}</svg>
);

export function SupplierCard({ route, id }: { route: Route; id: string }) {
  const st = useStore();
  const s = byId.get(id);
  const [notice, setNotice] = useState("");
  const anchor = useRef<HTMLDivElement>(null);
  // отзывы — в правой боковой панели (правка Павла 15.10): открывается из шапки или из плашки «Отзывы клиентов»
  const [revDrawer, setRevDrawer] = useState<null | "list" | "form">(null);
  const closeDrawer = useCallback(() => setRevDrawer(null), []);
  const revStat = useReviewStat(id);
  const rv = useSupplierReviews(id);
  useEffect(() => { setNotice(""); setRevDrawer(null); }, [id]);
  if (!s || (s.live_only && !st.collected[s.id])) {
    return (
      <>
        <div className="railed-main">
          <div className="empty">
            <h1 className="h1">Поставщик не найден</h1>
            <p>Возможно, карточка собрана живым сбором в другом браузере. <a href="#/">На главную →</a></p>
          </div>
        </div>
        <Footer />
      </>
    );
  }
  // категория — та, из которой пришли, если поставщик в ней есть хотя бы по подкатегории (T-538); иначе основная
  const own = categoryOf(s);
  const asked = catById(route.params.get("cat"));
  const cat = asked && inCategory(s, asked) ? asked : own;
  const guest = cat.id !== own.id;
  const mine = subsIn(s, cat);
  const p = new URLSearchParams(route.params);
  p.set("cat", cat.id);
  let q = readQuery(p);
  // гостя нет в «Вся категория» — место считаем среди тех подкатегорий, где он есть
  if (guest) {
    const picked = q.subs.filter((id) => mine.some((x) => x.id === id));
    q = { ...q, subs: picked.length && picked.length < cat.subcategories.length ? picked : mine.map((x) => x.id) };
  }
  const base = queryParams(q);
  // пул рейтинга — как у списка, из которого пришли: выбраны подкатегории — среди тех, кто в них есть (так считал и экран #/why)
  const pool = guest ? { members: true } : { subsOnly: true };
  const { ranked, excluded, peers } = rankCategory(q, st, pool);
  const place = ranked.findIndex((x) => x.supplier.id === s.id);
  // в шапке у гостя — подкатегория, из которой пришли; полный список — в разделе «Ассортимент»
  const shown = guest ? mine.filter((x) => q.subs.includes(x.id)) : mine;
  const whole = !guest && q.subs.length === cat.subcategories.length;
  const placeIn = whole ? "в категории" : q.subs.length === 1 ? `в подкатегории «${cat.subcategories.find((x) => x.id === q.subs[0])!.name}»` : "в подкатегориях";
  const stop = stopReason(s, new Set(st.returned));
  const sc = score(s, { volume: q.volume, category: cat, peers }, q.prio);
  const comp = completeness(s);
  const short = st.shortlist[s.id];
  const inCompare = st.compare.includes(s.id);
  const gaps = asks(sc, cat);
  const collectedNow = st.collected[s.id];
  const c = isKnown(s.company) ? s.company.value! : null;
  const flags = c ? fnsFlags(c.flags) : null;

  // разделы: адрес — источник правды; «назад» и «вперёд» ходят по разделам, страница при переключении не прыгает наверх
  const tabRaw = route.params.get("tab") as Tab | null;
  const tab: Tab = tabRaw && TABS.includes(tabRaw) ? tabRaw : "main";
  const here = (patch: Record<string, string | null>) => ({ ...paramsToObject(route.params), ...patch });
  const tabHref = (t: Tab) => href(`/s/${s.id}`, here({ tab: t === "main" ? null : t }));
  const go = (t: Tab) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (t !== tab) navigate(`/s/${s.id}`, here({ tab: t === "main" ? null : t }), { keepScroll: true });
    // начало раздела ушло вверх при прокрутке — возвращаемся к нему (на узком экране — под полосу меню и вкладок)
    requestAnimationFrame(() => {
      const a = anchor.current;
      if (a && a.getBoundingClientRect().top < (parseFloat(getComputedStyle(a).scrollMarginTop) || 0)) a.scrollIntoView({ block: "start" });
    });
  };
  const setPrio = (v: Priority) => navigate(`/s/${s.id}`, here({ prio: v === "balanced" ? null : v }), { replace: true });
  const setVs = (v: string | null) => navigate(`/s/${s.id}`, here({ vs: v }), { replace: true });
  // переход на другую компанию из рейтинга — сразу на её «Разбор» (выбор Павла): тот же набор весов, рейтинг под рукой
  const linkFor = (oid: string) => href(`/s/${oid}`, { ...base, tab: "why" });
  const places = tab === "why" ? Object.fromEntries(PRIORITIES.map((x) => {
    const r = rankCategory({ ...q, prio: x.id }, st, pool).ranked;
    const i = r.findIndex((y) => y.supplier.id === s.id);
    return [x.id, i < 0 ? null : { place: i + 1, n: r.length }];
  })) as Record<Priority, Place | null> : null;

  const toggleCompare = () => {
    if (st.compare.some((x) => { const o = byId.get(x); return !o || !inCategory(o, cat); })) actions.setCompare([s.id]);
    else if (!actions.toggleCompare(s.id)) setNotice("В сравнении уже четыре поставщика — уберите одного.");
  };

  const collected = <Collected s={s} comp={comp} now={!!collectedNow} />;
  const nav = (cls: string) => (
    <nav className={cls} aria-label="Разделы карточки">
      {TABS.map((t) => (
        <a key={t} className={`nav-item${t === tab ? " on" : ""}`} href={tabHref(t)} aria-current={t === tab ? "page" : undefined} onClick={go(t)}>
          <TabIcon t={t} /><span className="nav-l">{TAB_LABEL[t]}</span>
          {t === "assortment" && s.assortment?.value && <span className="nav-n num">{s.assortment.value.total_seen}</span>}
        </a>
      ))}
    </nav>
  );
  const prio = places && <PrioSwitch value={q.prio} places={places} onChange={setPrio} />;

  let body: ReactNode;
  if (tab === "why") {
    body = <Breakdown s={s} q={q} current={sc} stop={stop} ranked={ranked} excluded={excluded} vsId={route.params.get("vs")} prio={prio} onVs={setVs} linkFor={linkFor} />;
  } else if (tab === "terms") {
    body = <>{collected}<Terms s={s} /></>;
  } else if (tab === "docs") {
    body = <>{collected}<Docs s={s} cat={cat} /></>;
  } else if (tab === "assortment") {
    body = <>{collected}<Assortment s={s} /></>;
  } else {
    body = (
      <div className="card-grid">
        <div className="card-main">
          {collected}
          <div className="wdgs">
            <TermsWidget s={s} href={tabHref("terms")} onClick={go("terms")} />
            <DocsWidget s={s} cat={cat} href={tabHref("docs")} onClick={go("docs")} />
            <AssortWidget s={s} href={tabHref("assortment")} onClick={go("assortment")} />
          </div>
          <Sources s={s} />
        </div>

        <aside className="side">
          <div className="status">
            <div className="status-h">Компания {c ? <span className={`signal${c.status !== "active" ? " bad" : ""}`}>{{ active: "Действует", liquidating: "Ликвидируется", liquidated: "Ликвидирована", bankrupt: "Банкротство" }[c.status]}</span> : <span className="signal off">Не проверена</span>}</div>
            {c ? (
              <>
                <div className="status-big num">{ageYears(c.registered_at)}<span>{years(ageYears(c.registered_at)).replace(/^\d+ /, "")} на рынке</span></div>
                <div className="kv"><span>ОКВЭД {c.okved_main}</span><span>{c.okved_match ? "совпадает с категорией" : "не по профилю"}</span></div>
                {c.revenue.length > 0 && <div className="kv"><span>Выручка {c.revenue[c.revenue.length - 1].year}</span><span className="num">{num(c.revenue[c.revenue.length - 1].mln)} млн ₽{c.staff ? ` · ${c.staff} сотр.` : ""}</span></div>}
                <div className="kv">
                  <span>Красные флаги</span>
                  <span>
                    {flags!.real.length ? flags!.real.join(", ") : flags!.unchecked ? "не проверены" : "нет"}
                    {flags!.unchecked && !flags!.real.length && <Hint label="Почему не проверены">Сайт ФНС «Прозрачный бизнес» на время сбора закрылся капчей — флаги (недоимка, массовый адрес) не сверены. В балле это треть, как любое неизвестное.</Hint>}
                  </span>
                </div>
                <div className="kv"><span>Налоги</span><span>{isKnown(s.tax_regime) ? TAX[s.tax_regime.value!] : "не найдено"}</span></div>
                <div className="kv src-row"><span><StatusIcon status="found" size={10} /> реестр</span><SourceLinks s={s} ids={s.company.sources} /></div>
              </>
            ) : (
              <p className="status-empty">ИНН на сайте не найден — компанию не проверить. Попросите реквизиты в первом письме.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-h"><b>Контакты</b></div>
            <div className="mini-fields">
              <MiniField label="Телефон" status={s.phones.status} strong value={s.phones.value && s.phones.value.map((t, i) => <a key={i} href={`tel:${t.replace(/[^\d+]/g, "")}`}>{t}</a>)} />
              <MiniField label="Email" status={s.emails.status} value={s.emails.value && s.emails.value.map((e, i) => <a key={i} href={`mailto:${e}`}>{e}</a>)} />
              <MiniField label="Мессенджер" status={s.messengers.status} value={s.messengers.value?.join(", ")} />
              <MiniField label="Сайт" status={s.website.status} value={s.website.value && <a href={s.website.value} target="_blank" rel="noreferrer">{s.website.value.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗</a>} />
              <MiniField label="Адрес" status={s.address.status} value={s.address.value} />
              <MiniField label="Склад" status={s.presence.status} value={s.presence.value ? PRESENCE[s.presence.value] : null} />
            </div>
          </div>

          <ReviewsPlate s={s} list={rv.list} err={rv.err} stat={revStat} onOpen={setRevDrawer} />

          {gaps.length > 0 && (
            <div className="panel">
              <div className="panel-h"><b>Что уточнить</b><a className="nowrap" href={href("/shortlist", { draft: s.id })} onClick={() => actions.addShort(s.id)}>в черновик →</a></div>
              <ul className="asks">{gaps.slice(0, 5).map((a) => <li key={a.key}><StatusIcon status={a.mark} /> {a.label}</li>)}</ul>
            </div>
          )}

          <Notes id={s.id} status={short?.status} note={short?.note ?? ""} noteAt={short?.note_at ?? null} />
        </aside>
      </div>
    );
  }

  return (
    <Railed rail={
      <aside className="rail card-rail" aria-label="Страница поставщика">
        <div className="rail-in">
          <a className="crumb" href={href("/results", base)}>← {cat.name}</a>
          <div className="cr-who">
            <Avatar s={s} size={40} logo={logoOf(s.id)} color />
            <b>{s.name}</b>
          </div>
          {nav("card-nav")}
          {prio && <div className="cr-prio">{prio}</div>}
        </div>
      </aside>
    }>
      <div className="card-page">
        <header className="card-h2">
          <div className="card-id">
            <Avatar s={s} size={88} logo={logoOf(s.id)} color />
            <div className="card-title">
              <div className="label">
                <CatGlyph cat={cat} size={18} /> {cat.short}{shown.length > 0 && ` · ${shown.slice(0, 2).map((x) => x.name.toLowerCase()).join(" · ")}${shown.length > 2 ? ` · ещё ${shown.length - 2}` : ""}`}
                {guest && <GuestTag s={s} cat={cat} own={own} />}
              </div>
              <h1 className="h1">{s.name}{s.demo && <DemoPill />}{collectedNow && <span className="fresh-pill">собрано сейчас</span>}</h1>
              <div className="sub">
                <span>{isKnown(s.legal_name) ? s.legal_name.value : "юрлицо не указано"}</span>
                <span className="dot-sep" />
                {isKnown(s.inn) ? <span className="inn">ИНН <span className="num">{s.inn.value}</span> <StatusIcon status={isKnown(s.company) ? "found" : "claimed"} /></span> : <span className="miss inn">ИНН не найден <StatusIcon status="not_found" /></span>}
                <span className="dot-sep" />
                <span>{s.city}</span>
              </div>
              {revStat && <div className="card-rev"><ReviewBadge stat={revStat} onClick={() => setRevDrawer("list")} /></div>}
              <div className="actions">
                <a className="btn pr" href={href("/shortlist", { draft: s.id })} onClick={() => actions.addShort(s.id)}>Написать — черновик запроса</a>
                <StarButton on={!!short} onClick={() => actions.toggleShort(s.id)} label={short ? "В шорт-листе" : "В шорт-лист"} />
                <button type="button" className={`btn sec${inCompare ? " on" : ""}`} aria-pressed={inCompare} onClick={toggleCompare}>{inCompare ? "✓ В сравнении" : "Сравнить"}</button>
                {inCompare && st.compare.length >= 2 && <a className="btn sec" href={href("/compare", { ids: st.compare.join(","), cat: cat.id, vol: volParam(q.volume), prio: base.prio })}>Открыть сравнение · {st.compare.length}</a>}
                <button type="button" className="btn ghost" onClick={() => setNotice("Обновление карточки из набора по кнопке пока не подключено: набор пересобирается конвейером целиком, дата сбора — у каждого поля. Карточку поставщика не из набора соберёт «Знаю поставщика» — 2–4 минуты, около 1 ₽.")}>Обновить данные</button>
              </div>
            </div>
          </div>

          <section className="score-panel" aria-label="Балл рекомендации">
            {stop ? (
              <div className="sp-stop"><span className="label light">Исключён из рекомендации</span><b>{stop.reason}</b></div>
            ) : (
              <>
                <div className="sp-head">
                  <div className={`sp-big num lv-${level(sc.total)}`}>{sc.total}<span>/100</span></div>
                  <div className="sp-place">{place + 1}-й из {ranked.length}<br />{placeIn}</div>
                </div>
                <div className="sp-crits">
                  {CRITS.map((cr) => (
                    <Rule key={cr.id} compact value={sc.crits[cr.id].score} left={cr.short} right={`${Math.round(sc.crits[cr.id].score * 100)}`} />
                  ))}
                </div>
                <div className="sp-foot">
                  <label className="sp-prio">
                    <span>Веса</span>
                    <select value={q.prio} onChange={(e) => setPrio(e.target.value as Priority)} aria-label="Что важнее — веса балла">
                      {PRIORITIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                    <Hint label="Как считается балл">Шкала 0–100 по каждому критерию. Неизвестное — треть шкалы: повод уточнить, а не приговор. Веса — «что важнее»: поменяйте здесь или в разделе «Разбор», балл и место пересчитаются.</Hint>
                  </label>
                  {tab !== "why" && <a href={tabHref("why")} onClick={go("why")}>Почему {sc.total} — разбор →</a>}
                </div>
              </>
            )}
          </section>
        </header>
        {notice && <div className="notice" role="status">{notice}</div>}

        {/* на телефоне колонка — над шапкой, поэтому меню разделов здесь же полосой вкладок */}
        <div ref={anchor} className="tabs-anchor" />
        {nav("card-tabs")}

        <div className={`card-body tab-${tab}`}>{body}</div>
      </div>
      {revDrawer && <ReviewsDrawer s={s} list={rv.list} err={rv.err} setList={rv.setList} startWithForm={revDrawer === "form"} onClose={closeDrawer} />}
    </Railed>
  );
}

/** Сколько полей найдено и откуда — шириной своего столбца, правый не делит (правка Павла 15.10). */
function Collected({ s, comp, now }: { s: Supplier; comp: { found: number; total: number }; now: boolean }) {
  const sitePages = s.meta.sources.filter((x) => x.kind === "site").length;
  const regs = [...new Set(s.meta.sources.filter((x) => x.kind === "registry").map((x) => x.title.split(":")[0]))];
  return (
    <div className="collected">
      <FillBar found={comp.found} total={comp.total} compact />
      <span className="col-k">полей найдено</span>
      <span className="dot-sep" />
      <span>{now ? "собрано сейчас" : `собрано ${dateRu(s.meta.collected_at)}`}</span>
      <Hint label="Как читать карточку">У каждого поля — знак и ссылка на источник: ● государственный реестр, ◐ со слов поставщика (подтвердить при первом контакте), ○ не найдено, ◇ оценка по рынку. Под значением с сайта — дословная цитата.</Hint>
      <span className="col-src">сайт · {sitePages} стр.{regs.length ? ` · ${regs.join(", ")}` : ""}</span>
    </div>
  );
}

/** Источники карточки — информация, поэтому в левом столбце «Основного» (у полей во вкладках — свои ссылки). */
function Sources({ s }: { s: Supplier }) {
  return (
    <section className="fsec">
      <h2 className="section-h">Источники <span className="find-n num">{s.meta.sources.length}</span></h2>
      <ul className="sources two">
        {s.meta.sources.map((src) => (
          <li key={src.id}>
            <span className={`kind k-${src.kind}`}>{sourceLabel(src)}</span>
            {src.url ? <a href={src.url} target="_blank" rel="noreferrer">{src.title.replace(/^Сайт: /, "")}</a> : <span>{src.title.replace(/^Сайт: /, "")}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function hoursText(h: Hours) {
  const parts = [h.office && `работают ${h.office}`, h.order_cutoff, h.delivery_days && `доставка ${h.delivery_days}`, h.delivery_window && `окно ${h.delivery_window}`, h.evening_or_night && "возят вечером или ночью"].filter(Boolean);
  return parts.join(" · ") || null;
}

function Terms({ s }: { s: Supplier }) {
  return (
    <section className="fsec">
      <h2 className="section-h">Условия</h2>
      <FieldRow s={s} label="Минимальный заказ" f={s.min_order} value={s.min_order.value ? minOrderText(s.min_order.value) : null} />
      <FieldRow s={s} label="Цены" f={s.prices}
        value={s.prices.value && <>{PRICE_MODE[s.prices.value.mode]}{s.prices.value.examples.length > 0 && <span className="v-sub">{s.prices.value.examples.map((e) => `${e.item} — ${e.price}`).join(" · ")}</span>}</>}
        extra={s.price_estimate && <div className="est-line"><StatusIcon status="estimated" /> ориентир рынка: {s.price_estimate.value}<Hint label="Ориентир рынка">{s.price_estimate.basis}. В балл не идёт.</Hint></div>} />
      <FieldRow s={s} label="Доставка" f={s.delivery} value={s.delivery.value && deliveryText(s.delivery.value)} />
      {s.hours && <FieldRow s={s} label="Часы и окно доставки" f={s.hours} value={s.hours.value && hoursText(s.hours.value)} />}
      <FieldRow s={s} label="Регион работы" f={s.regions_served} value={s.regions_served.value?.join(", ")} />
      <FieldRow s={s} label="Работа с ресторанами" f={s.works_with_horeca} value={s.works_with_horeca.value === null ? null : s.works_with_horeca.value ? "да — HoReCa и юрлица по договору" : "нет — розничные продажи"} />
      <FieldRow s={s} label="Оплата и отсрочка" f={s.payment_terms} value={s.payment_terms.value} />
    </section>
  );
}

function Docs({ s, cat }: { s: Supplier; cat: Category }) {
  const decls = s.documents.declarations.value ?? [];
  const inProfile = new Set(profileDeclarations(s, cat).map((d) => d.number));
  return (
    <section className="fsec">
      <h2 className="section-h">
        Документы
        {cat.docs_critical && <Hint label="Ветеринарные документы">Ветеринарные документы по ИНН публично не проверить: поиск в ВетИС работает только по номеру площадки или документа. Попросите их у поставщика — сам ресторан увидит их у себя в «Меркурии». Вопрос уже в черновике письма.</Hint>}
      </h2>
      <FieldRow s={s} label="Декларации" f={s.documents.declarations}
        value={decls.length > 0 && (
          <ul className="decls">
            {decls.map((d) => {
              const active = d.status === "действует" && new Date(d.valid_to) > new Date();
              const why = !active ? " · не действует — в балл не идёт" : !inProfile.has(d.number) ? " · не на продукцию категории — в балл не идёт" : "";
              return (
                <li key={d.number} className={why ? "off" : ""}>
                  <DocGlyph size={24} />
                  <div>
                    <div>{d.product}</div>
                    <div className="q plain"><span className="num">{d.number}</span> · {d.status} до {monthYear(d.valid_to)}{why}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )} />
      {s.documents.marking ? (
        <FieldRow s={s} label="«Честный знак»" f={s.documents.marking} value={s.documents.marking.value && `участник: ${s.documents.marking.value.join(", ")}`} />
      ) : (
        <div className="field"><span className="k">«Честный знак»</span><div><div className="v miss">не применимо<Hint>Группы маркировки проверяем для рыбы и молочного; упаковка и бакалея в этих группах не маркируются.</Hint></div></div><span className="field-src">—</span></div>
      )}
      <FieldRow s={s} label="На сайте" f={s.documents.site_mentions} value={s.documents.site_mentions.value} />
    </section>
  );
}

// ---------- виджеты вкладки «Основное»: весь виджет — ссылка на свою вкладку ----------
function Widget({ t, href, onClick, more, children }: { t: Tab; href: string; onClick: (e: MouseEvent) => void; more: string; children: ReactNode }) {
  return (
    <a className={`wdg wdg-${t}`} href={href} onClick={onClick}>
      <span className="wdg-h"><TabIcon t={t} /><b>{TAB_LABEL[t]}</b></span>
      {children}
      <span className="wdg-more">{more} <span aria-hidden="true">→</span></span>
    </a>
  );
}

function WRow({ k, status, children }: { k: string; status: FieldStatus; children: ReactNode }) {
  const miss = status === "not_found";
  return <span className={`wrow${miss ? " miss" : ""}`}><span className="k">{k}</span><span className="v">{children}</span><StatusIcon status={status} size={10} /></span>;
}

function TermsWidget({ s, href, onClick }: { s: Supplier; href: string; onClick: (e: MouseEvent) => void }) {
  return (
    <Widget t="terms" href={href} onClick={onClick} more="Все условия">
      <span className="wrows">
        <WRow k="Мин. заказ" status={s.min_order.status}>{s.min_order.value ? minOrderText(s.min_order.value) : "не найдено"}</WRow>
        <WRow k="Доставка" status={s.delivery.status}>{isKnown(s.delivery) ? deliveryShort(s.delivery.value!) : "не найдено"}</WRow>
        <WRow k="Цены" status={s.prices.status}>{isKnown(s.prices) ? PRICE_MODE[s.prices.value!.mode] : "не найдено"}</WRow>
        <WRow k="Оплата" status={s.payment_terms.status}>{s.payment_terms.value ?? "не найдено"}</WRow>
        {s.hours?.value?.office && <WRow k="Часы" status={s.hours.status}>{s.hours.value.office}</WRow>}
      </span>
    </Widget>
  );
}

function DocsWidget({ s, cat, href, onClick }: { s: Supplier; cat: Category; href: string; onClick: (e: MouseEvent) => void }) {
  const all = s.documents.declarations.value ?? [];
  const n = profileDeclarations(s, cat).length;
  return (
    <Widget t="docs" href={href} onClick={onClick} more="Документы">
      <span className="wbig">
        <DocGlyph size={30} />
        <span><b className="num">{n}</b> {plural(n, "действующая декларация", "действующие декларации", "действующих деклараций")}<br /><span className="sub">на продукцию категории{all.length > n ? ` · всего в реестре ${all.length}` : ""}</span></span>
      </span>
      <span className="wrows">
        <WRow k="«Честный знак»" status={s.documents.marking?.status ?? "not_found"}>{s.documents.marking ? (s.documents.marking.value ? s.documents.marking.value.join(", ") : "не найдено") : "не применимо"}</WRow>
        <WRow k="На сайте" status={s.documents.site_mentions.status}>{isKnown(s.documents.site_mentions) ? "упоминания есть" : "не найдено"}</WRow>
      </span>
    </Widget>
  );
}

function AssortWidget({ s, href, onClick }: { s: Supplier; href: string; onClick: (e: MouseEvent) => void }) {
  const a = s.assortment && isKnown(s.assortment) ? s.assortment.value! : null;
  const subs = subsIn(s, categoryOf(s));
  return (
    <Widget t="assortment" href={href} onClick={onClick} more={a ? "Весь ассортимент" : "Товары"}>
      {a ? (
        <>
          <span className="wbig">
            <CatGlyph cat={categoryOf(s)} size={30} />
            <span><b className="num">{a.total_seen}</b> {plural(a.total_seen, "позиция", "позиции", "позиций")} на сайте<br /><span className="sub">{subs.slice(0, 4).map((x) => x.name.toLowerCase()).join(" · ")}{subs.length > 4 ? ` · ещё ${subs.length - 4}` : ""}</span></span>
          </span>
          <span className="wlist">{a.items.slice(0, 6).map((it, i) => <span key={i}>{it.name}</span>)}</span>
        </>
      ) : <span className="wrows"><WRow k="Примеры" status={s.products.status}>{s.products.value?.join(", ") ?? "не найдено"}</WRow></span>}
    </Widget>
  );
}

/** Ассортимент: полный список с каталога или прайса (T-535), пока его нет — примеры товаров. */
function Assortment({ s }: { s: Supplier }) {
  const a = s.assortment && isKnown(s.assortment) ? s.assortment.value! : null;
  if (!a) {
    return (
      <section className="fsec">
        <h2 className="section-h">Товары<Hint label="Ассортимент">Сейчас — примеры товаров с сайта. Полный список с каталога и прайса собирается следующим шагом: тогда по нему же заработает поиск по товару.</Hint></h2>
        <FieldRow s={s} label="Примеры" f={s.products} value={s.products.value?.join(", ")} />
      </section>
    );
  }
  // подкатегории по ассортименту, основная категория первой; каждая — ссылка на всех, кто её продаёт (T-538)
  const groups = [categoryOf(s), ...CATEGORIES.filter((c) => c.id !== s.category)].map((c) => ({ c, subs: subsIn(s, c) })).filter((g) => g.subs.length);
  return (
    <section className="fsec">
      <h2 className="section-h">Ассортимент <span className="find-n num">{a.total_seen}</span></h2>
      {groups.length > 0 && (
        <div className="in-subs">
          <span className="found-k">В подкатегориях<Hint label="Как считаются подкатегории">Поставщик попадает в подкатегорию по позициям со своего сайта — даже если его основная категория другая: стаканы продаёт и оптовик продуктов. Ссылка ведёт ко всем, кто продаёт эту позицию.</Hint></span>
          {groups.map(({ c, subs }) => (
            <div key={c.id} className="in-subs-line">
              <CatGlyph cat={c} size={20} /> <b>{c.short}:</b>{" "}
              {subs.map((x, i) => <span key={x.id}>{i > 0 && " · "}<a href={href("/results", { cat: c.id, sub: x.id })}>{x.name.toLowerCase()}</a></span>)}
            </div>
          ))}
        </div>
      )}
      <ul className="assort">
        {a.items.map((it, i) => <li key={i}><span>{it.name}</span>{it.price && <span className="num muted">{it.price}</span>}</li>)}
      </ul>
      <div className="assort-foot">
        {a.truncated && <span className="sub">на сайте {a.total_seen} {plural(a.total_seen, "позиция", "позиции", "позиций")}, собрали {a.items.length}</span>}
        <span className="field-src"><StatusIcon status={s.assortment!.status} /><SourceLinks s={s} ids={s.assortment!.sources} /></span>
      </div>
    </section>
  );
}

/** Плашка отзывов на «Основном»: с карт — только ссылкой (их условия запрещают хранить данные); свои — на сервере (T-536).
 *  Средняя и «N отзывов» открывают правую панель со списком, сортировкой и фильтром; «Оставить отзыв» — форма там же (T-543). */
function ReviewsPlate({ s, list, err, stat, onOpen }: { s: Supplier; list: ReviewList | null; err: string | null; stat: ReviewStat | null; onOpen: (m: "list" | "form") => void }) {
  const q = encodeURIComponent(`${s.name} ${s.city}`);
  const gis = s.map_link ?? `https://2gis.ru/ekaterinburg/search/${encodeURIComponent(s.name)}`;
  // средняя и число — свежий список с сервера, пока он не пришёл — сводка; примеры входят как обычные отзывы
  const st = list ? mergeStat({ count: list.count, avg: list.avg }, s.id) : stat;
  return (
    <div className="panel rev-panel" id="reviews">
      <div className="panel-h"><b>Отзывы клиентов<Hint label="Откуда отзывы">Отзывы закупщиков хранятся в сервисе и видны всем; оставить можно без регистрации, модерации в прототипе нет. Сохраняются оценка, текст и имя, если его указали; ваш адрес не хранится — только его хеш, чтобы считать повторы. Рейтинги с Яндекс Карт и 2ГИС хранить у себя запрещают условия карт, поэтому — переход к ним.</Hint></b></div>
      <div className="rev-links">
        <a className="pill-out sm" href={`https://yandex.ru/maps/54/yekaterinburg/?text=${q}`} target="_blank" rel="noreferrer">Яндекс Карты ↗</a>
        <a className="pill-out sm" href={gis} target="_blank" rel="noreferrer">2ГИС ↗</a>
      </div>
      {err && <p className="rev-own">{err}</p>}
      {st ? (
        <button type="button" className="rev-sum" aria-haspopup="dialog" onClick={() => onOpen("list")}>
          <b className="num">{avgText(st.avg)}</b>
          <Stars avg={st.avg} />
          <span className="rev-n">{st.count} {plural(st.count, "отзыв", "отзыва", "отзывов")}</span>
          <span className="rev-chev" aria-hidden="true">→</span>
        </button>
      ) : (list || err) && <div className="rev-sum-none sub">Отзывов закупщиков пока нет — станьте первым.</div>}
      <div className="row-btns"><button type="button" className="btn sec sm" onClick={() => onOpen("form")}>Оставить отзыв</button></div>
    </div>
  );
}

function MiniField({ label, status, value, strong }: { label: string; status: FieldStatus; value: ReactNode | null | undefined; strong?: boolean }) {
  const list = Array.isArray(value) ? value : null;
  return (
    <div className="mf-row">
      <span className="k">{label}</span>
      <span className={value ? (strong ? "strong mf-v" : "mf-v") : "miss"}>
        {list ? list.map((v, i) => <span key={i}>{i > 0 && ", "}{v}</span>) : value ?? "не найдено"}
      </span>
      <StatusIcon status={status} />
    </div>
  );
}

function Notes({ id, status, note, noteAt }: { id: string; status?: ContactStatus; note: string; noteAt: string | null }) {
  const [text, setText] = useState(note);
  useEffect(() => setText(note), [id, note]);
  // статус и заметка — у записи шорт-листа: без звёздочки поставщик попадает туда только явным действием
  if (!status) {
    return (
      <div className="panel notes">
        <div className="panel-h"><b>Мои заметки <StatusIcon status="user" /></b></div>
        <p className="notes-off">Статус контакта и заметки ведутся для поставщиков из шорт-листа.</p>
        <button type="button" className="btn sec sm" onClick={() => actions.addShort(id)}>В шорт-лист</button>
      </div>
    );
  }
  return (
    <div className="panel notes">
      <div className="panel-h">
        <b>Мои заметки <StatusIcon status="user" /><Hint>Статус и заметка хранятся в этом браузере и видны и здесь, и в шорт-листе.</Hint></b>
        {noteAt && <span className="sub">сохранено {new Date(noteAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}
      </div>
      <label className="label" htmlFor={`st-${id}`}>Статус контакта</label>
      <select id={`st-${id}`} className="input" value={status} onChange={(e) => actions.setStatus(id, e.target.value as ContactStatus)}>
        {CONTACT_STATUSES.map((x) => <option key={x}>{x}</option>)}
      </select>
      <label className="label" htmlFor={`note-${id}`}>Заметка</label>
      <textarea id={`note-${id}`} className="input" rows={3} value={text} placeholder="например: прайс для сетей отдельный, обещали прислать"
        onChange={(e) => setText(e.target.value)} onBlur={() => text !== note && actions.setNote(id, text)} />
      <div className="row-btns">
        <button type="button" className="btn sec sm" disabled={text === note} onClick={() => actions.setNote(id, text)}>Сохранить заметку</button>
      </div>
    </div>
  );
}
