// Карточка поставщика. Слева — таблица полей с цитатами, справа — плашки.
// Два тёмных акцента: балл с разбором в шапке и «Компания»; остальное — серые плашки.
import { useEffect, useState, type ReactNode } from "react";
import { href, type Route } from "../router.ts";
import { actions, CONTACT_STATUSES, useStore, type ContactStatus } from "../store.ts";
import { byId, catById, CATEGORIES, categoryOf, inCategory, queryParams, rankCategory, readQuery, subsIn, volParam } from "../data.ts";
import { asks } from "../lib/explain.ts";
import { completeness, CRITS, fnsFlags, profileDeclarations, score, stopReason } from "../lib/score.ts";
import { ageYears, dateRu, isKnown, minOrderText, monthYear, num, plural, years } from "../lib/format.ts";
import type { FieldStatus, Hours, Supplier } from "../types.ts";
import { CatGlyph, DemoPill, DocGlyph, Hint, Mono, Rule, StarButton, StatusIcon } from "../components/ui.tsx";
import { deliveryText, FieldRow, GuestTag, PRICE_MODE, SourceLinks, sourceLabel } from "../components/supplier.tsx";
import { addReview, ApiError, reviews as loadReviews, type Reviews as ReviewList } from "../lib/api.ts";

const TAX = { general: "общий — счета с НДС", usn: "УСН — без НДС" } as const;
const PRESENCE = { warehouse: "склад в городе", delivery_only: "без склада в городе", unknown: "не известно" } as const;

export function SupplierCard({ route, id }: { route: Route; id: string }) {
  const st = useStore();
  const s = byId.get(id);
  const [notice, setNotice] = useState("");
  useEffect(() => setNotice(""), [id]);
  if (!s || (s.live_only && !st.collected[s.id])) {
    return (
      <div className="empty">
        <h1 className="h1">Поставщик не найден</h1>
        <p>Возможно, карточка собрана живым сбором в другом браузере. <a href="#/">На главную →</a></p>
      </div>
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
  const { ranked, peers } = rankCategory(q, st, guest ? { members: true } : {});
  const place = ranked.findIndex((x) => x.supplier.id === s.id);
  // в шапке у гостя — подкатегория, из которой пришли; полный список — в блоке «Ассортимент»
  const shown = guest ? mine.filter((x) => q.subs.includes(x.id)) : mine;
  const placeIn = !guest ? "в категории" : q.subs.length === 1 ? `в подкатегории «${mine.find((x) => x.id === q.subs[0])!.name}»` : "в подкатегориях";
  const stop = stopReason(s, new Set(st.returned));
  const sc = score(s, { volume: q.volume, category: cat, peers }, q.prio);
  const comp = completeness(s);
  const short = st.shortlist[s.id];
  const inCompare = st.compare.includes(s.id);
  const gaps = asks(sc, cat);
  const collectedNow = st.collected[s.id];
  const c = isKnown(s.company) ? s.company.value! : null;
  const flags = c ? fnsFlags(c.flags) : null;
  const sitePages = s.meta.sources.filter((x) => x.kind === "site").length;
  const regs = [...new Set(s.meta.sources.filter((x) => x.kind === "registry").map((x) => x.title.split(":")[0]))];
  const decls = s.documents.declarations.value ?? [];
  const inProfile = new Set(profileDeclarations(s, cat).map((d) => d.number));

  const toggleCompare = () => {
    if (st.compare.some((x) => { const o = byId.get(x); return !o || !inCategory(o, cat); })) actions.setCompare([s.id]);
    else if (!actions.toggleCompare(s.id)) setNotice("В сравнении уже четыре поставщика — уберите одного.");
  };

  return (
    <div className="card-page">
      <a className="crumb" href={href("/results", base)}>← {cat.name}</a>

      <header className="card-h2">
        <div className="card-id">
          <Mono s={s} size={88} />
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
            <div className="actions">
              <a className="btn pr" href={href("/shortlist", { draft: s.id })} onClick={() => actions.addShort(s.id)}>Написать — черновик запроса</a>
              <StarButton on={!!short} onClick={() => actions.toggleShort(s.id)} label={short ? "В шорт-листе" : "В шорт-лист"} />
              <button type="button" className={`btn sec${inCompare ? " on" : ""}`} aria-pressed={inCompare} onClick={toggleCompare}>{inCompare ? "✓ В сравнении" : "Сравнить"}</button>
              {inCompare && st.compare.length >= 2 && <a className="btn sec" href={href("/compare", { ids: st.compare.join(","), cat: cat.id, vol: volParam(q.volume), prio: base.prio })}>Открыть сравнение · {st.compare.length}</a>}
              <button type="button" className="btn ghost" onClick={() => setNotice("Обновление карточки — это живой сбор по одному поставщику (~30 с, ~1 ₽). Сервер сбора появится вместе с публикацией; сейчас конвейер запускается из командной строки.")}>Обновить данные</button>
            </div>
          </div>
        </div>

        <section className="score-panel" aria-label="Балл рекомендации">
          {stop ? (
            <div className="sp-stop"><span className="label light">Исключён из рекомендации</span><b>{stop.reason}</b></div>
          ) : (
            <>
              <div className="sp-head">
                <div className="sp-big num">{sc.total}<span>/100</span></div>
                <div className="sp-place">{place + 1}-й из {ranked.length}<br />{placeIn}</div>
              </div>
              <div className="sp-crits">
                {CRITS.map((cr) => (
                  <Rule key={cr.id} compact value={sc.crits[cr.id].score} left={cr.short} right={`${Math.round(sc.crits[cr.id].score * 100)}`} />
                ))}
              </div>
              <div className="sp-foot">
                <span>Веса — «{q.prio === "balanced" ? "сбалансированно" : q.prio === "reliability" ? "надёжность и документы" : q.prio === "terms" ? "условия и цена" : "быстрая доставка"}»<Hint label="Как считается балл">Шкала 0–100 по каждому критерию. Неизвестное — треть шкалы: повод уточнить, а не приговор. Веса зависят от «что важнее».</Hint></span>
                <a href={href("/why", { ...base, id: s.id })}>Почему {sc.total} — разбор →</a>
              </div>
            </>
          )}
        </section>
      </header>
      {notice && <div className="notice" role="status">{notice}</div>}

      <div className="collected">
        <span><b className="num">{comp.found}</b> из {comp.total} полей найдено</span>
        <span className="dot-sep" />
        <span>{collectedNow ? "собрано сейчас" : `собрано ${dateRu(s.meta.collected_at)}`}</span>
        <span className="dot-sep" />
        <span>сайт · {sitePages} стр.{regs.length ? ` · ${regs.join(", ")}` : ""}</span>
        <Hint label="Как читать карточку">У каждого поля — знак и ссылка на источник: ● государственный реестр, ◐ со слов поставщика (подтвердить при первом контакте), ○ не найдено, ◇ оценка по рынку. Под значением с сайта — дословная цитата.</Hint>
      </div>

      <div className="card-grid">
        <div className="fields">
          <section>
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

          <section>
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

          <Assortment s={s} />
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

          <Reviews s={s} />

          {gaps.length > 0 && (
            <div className="panel">
              <div className="panel-h"><b>Что уточнить</b><a className="nowrap" href={href("/shortlist", { draft: s.id })} onClick={() => actions.addShort(s.id)}>в черновик →</a></div>
              <ul className="asks">{gaps.slice(0, 5).map((a) => <li key={a.key}><StatusIcon status={a.mark} /> {a.label}</li>)}</ul>
            </div>
          )}

          <Notes id={s.id} status={short?.status} note={short?.note ?? ""} noteAt={short?.note_at ?? null} />

          <div className="panel">
            <div className="panel-h"><b>Источники</b><span className="sub num">{s.meta.sources.length}</span></div>
            <ul className="sources">
              {s.meta.sources.map((src) => (
                <li key={src.id}>
                  <span className={`kind k-${src.kind}`}>{sourceLabel(src)}</span>
                  {src.url ? <a href={src.url} target="_blank" rel="noreferrer">{src.title.replace(/^Сайт: /, "")}</a> : <span>{src.title.replace(/^Сайт: /, "")}</span>}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function hoursText(h: Hours) {
  const parts = [h.office && `работают ${h.office}`, h.order_cutoff, h.delivery_days && `доставка ${h.delivery_days}`, h.delivery_window && `окно ${h.delivery_window}`, h.evening_or_night && "возят вечером или ночью"].filter(Boolean);
  return parts.join(" · ") || null;
}

/** Ассортимент: полный список с каталога или прайса (T-535), пока его нет — примеры товаров. */
function Assortment({ s }: { s: Supplier }) {
  const [all, setAll] = useState(false);
  const a = s.assortment && isKnown(s.assortment) ? s.assortment.value! : null;
  if (!a) {
    return (
      <section>
        <h2 className="section-h">Товары<Hint label="Ассортимент">Сейчас — примеры товаров с сайта. Полный список с каталога и прайса собирается следующим шагом: тогда по нему же заработает поиск по товару.</Hint></h2>
        <FieldRow s={s} label="Примеры" f={s.products} value={s.products.value?.join(", ")} />
      </section>
    );
  }
  const items = all ? a.items : a.items.slice(0, 12);
  // подкатегории по ассортименту, основная категория первой; каждая — ссылка на всех, кто её продаёт (T-538)
  const groups = [categoryOf(s), ...CATEGORIES.filter((c) => c.id !== s.category)].map((c) => ({ c, subs: subsIn(s, c) })).filter((g) => g.subs.length);
  return (
    <section>
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
        {items.map((it, i) => <li key={i}><span>{it.name}</span>{it.price && <span className="num muted">{it.price}</span>}</li>)}
      </ul>
      <div className="assort-foot">
        {a.items.length > 12 && <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>{all ? "свернуть" : `показать все ${a.items.length}`}</button>}
        {a.truncated && <span className="sub">на сайте {a.total_seen} {plural(a.total_seen, "позиция", "позиции", "позиций")}, собрали {a.items.length}</span>}
        <span className="field-src"><StatusIcon status={s.assortment!.status} /><SourceLinks s={s} ids={s.assortment!.sources} /></span>
      </div>
    </section>
  );
}

/** Отзывы: с карт — только ссылкой (их условия запрещают хранить данные); свои — на сервере (T-536), видны всем. */
function Reviews({ s }: { s: Supplier }) {
  const q = encodeURIComponent(`${s.name} ${s.city}`);
  const gis = s.map_link ?? `https://2gis.ru/ekaterinburg/search/${encodeURIComponent(s.name)}`;
  const [list, setList] = useState<ReviewList | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [trap, setTrap] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    setList(null); setLoadErr(null); setOpen(false); setSent(false);
    loadReviews(s.id).then(setList).catch((e) => setLoadErr(e instanceof ApiError ? e.message : "Отзывы не загрузились."));
  }, [s.id]);

  const send = async () => {
    setSending(true); setSendErr(null);
    try {
      setList(await addReview(s.id, { rating, text, author, website: trap }));
      setSent(true); setOpen(false); setText(""); setRating(0);
    } catch (e) {
      setSendErr(e instanceof ApiError ? e.message : "Отзыв не отправился. Попробуйте ещё раз.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-h"><b>Отзывы клиентов<Hint label="Откуда отзывы">Отзывы закупщиков хранятся в сервисе и видны всем; оставить можно без регистрации, модерации в прототипе нет. Рейтинги с Яндекс Карт и 2ГИС хранить у себя запрещают условия карт, поэтому — переход к ним.</Hint></b></div>
      <div className="rev-links">
        <a className="pill-out sm" href={`https://yandex.ru/maps/54/yekaterinburg/?text=${q}`} target="_blank" rel="noreferrer">Яндекс Карты ↗</a>
        <a className="pill-out sm" href={gis} target="_blank" rel="noreferrer">2ГИС ↗</a>
      </div>

      {loadErr && <p className="rev-own">{loadErr}</p>}
      {list && (
        <>
          <div className="rev-sum">
            {list.count ? <><b className="num">{list.avg?.toFixed(1)}</b><span className="rev-stars" aria-hidden="true">{"★".repeat(Math.round(list.avg ?? 0))}</span><span className="sub">{list.count} {plural(list.count, "отзыв закупщика", "отзыва закупщиков", "отзывов закупщиков")}</span></>
              : <span className="sub">Отзывов закупщиков пока нет — станьте первым.</span>}
          </div>
          {list.items.length > 0 && (
            <ul className="rev-list">
              {list.items.slice(0, 5).map((r, i) => (
                <li key={i}>
                  <span className="rev-stars" aria-label={`Оценка ${r.rating} из 5`}>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span> {r.text}
                  <span className="sub">{r.author ?? "Закупщик"} · {new Date(r.created_at).toLocaleDateString("ru-RU")}</span>
                </li>
              ))}
            </ul>
          )}
          {sent && <p className="rev-own">Спасибо — отзыв виден всем, кто откроет карточку.</p>}
          {!open && !sent && <div className="row-btns"><button type="button" className="btn sec sm" onClick={() => setOpen(true)}>Оставить отзыв</button></div>}
          {open && (
            <div className="rev-form">
              <span className="label">Оценка</span>
              <div className="rev-rate" role="group" aria-label="Оценка от 1 до 5">
                {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className={n <= rating ? "on" : ""} aria-pressed={n === rating} onClick={() => setRating(n)}>{n}</button>)}
              </div>
              <label className="label" htmlFor={`rev-t-${s.id}`}>Отзыв</label>
              <textarea id={`rev-t-${s.id}`} className="input" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="например: привозят вовремя, цены как в прайсе; минимальный заказ на деле выше" />
              <label className="label" htmlFor={`rev-a-${s.id}`}>Кто вы — по желанию</label>
              <input id={`rev-a-${s.id}`} className="input" maxLength={60} value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="например: кафе на Ленина" />
              <input className="rev-trap" tabIndex={-1} autoComplete="off" aria-hidden="true" value={trap} onChange={(e) => setTrap(e.target.value)} name="website" />
              {sendErr && <p className="rev-own">{sendErr}</p>}
              <div className="row-btns">
                <button type="button" className="btn pr sm" disabled={!rating || text.trim().length < 10 || sending} onClick={send}>{sending ? "Отправляю…" : "Отправить"}</button>
                <button type="button" className="btn sec sm" onClick={() => setOpen(false)}>Отмена</button>
              </div>
            </div>
          )}
        </>
      )}
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
