import { useEffect, useState } from "react";
import { href, type Route } from "../router.ts";
import { actions, CONTACT_STATUSES, useStore, type ContactStatus } from "../store.ts";
import { byId, categoryOf, queryParams, rankCategory, readQuery } from "../data.ts";
import { asks } from "../lib/explain.ts";
import { completeness, CRITS, score, stopReason } from "../lib/score.ts";
import { ageYears, dateRu, isKnown, minOrderText, monthYear, num, years } from "../lib/format.ts";
import type { FieldStatus } from "../types.ts";
import { CatGlyph, DemoPill, DocGlyph, Gauge, Hint, Mono, Rule, StarButton, StatusIcon } from "../components/ui.tsx";
import { deliveryText, FieldRow, PRICE_MODE, SourceLinks, sourceLabel } from "../components/supplier.tsx";

const TAX = { general: "общий — счета с НДС", usn: "УСН — без НДС" } as const;
const PRESENCE = { warehouse: "склад в городе", delivery_only: "только доставка", unknown: "не известно" } as const;

export function SupplierCard({ route, id }: { route: Route; id: string }) {
  const st = useStore();
  const s = byId.get(id);
  const [notice, setNotice] = useState("");
  useEffect(() => setNotice(""), [id]);
  if (!s || (s.live_only && !st.collected[s.id])) {
    return (
      <div className="empty">
        <h1 className="h1">Поставщик не найден</h1>
        <p>Возможно, карточка собрана живым сбором в другом браузере. <a href="#/">Вернуться к поиску →</a></p>
      </div>
    );
  }
  const cat = categoryOf(s);
  const p = new URLSearchParams(route.params);
  p.set("cat", cat.id);
  const q = readQuery(p);
  const base = queryParams(q);
  const { ranked } = rankCategory(q, st);
  const place = ranked.findIndex((x) => x.supplier.id === s.id);
  const stop = stopReason(s, new Set(st.returned));
  const sc = score(s, { volume: q.volume, category: cat, peers: ranked.map((r) => r.supplier) }, q.prio);
  const comp = completeness(s);
  const short = st.shortlist[s.id];
  const inCompare = st.compare.includes(s.id);
  const gaps = asks(sc, cat);
  const collectedNow = st.collected[s.id];
  const c = isKnown(s.company) ? s.company.value! : null;
  const sitePages = s.meta.sources.filter((x) => x.kind === "site").length;
  const regs = [...new Set(s.meta.sources.filter((x) => x.kind === "registry").map((x) => x.title.split(":")[0]))];

  const toggleCompare = () => {
    if (st.compare.some((x) => byId.get(x)?.category !== cat.id)) actions.setCompare([s.id]);
    else if (!actions.toggleCompare(s.id)) setNotice("В сравнении уже четыре поставщика — уберите одного.");
  };

  return (
    <div className="card-page">
      <a className="crumb" href={href("/results", base)}>← {cat.name}</a>

      <header className="card-h">
        <Mono s={s} size={88} />
        <div className="card-title">
          <div className="label">
            <CatGlyph cat={cat} size={18} /> {cat.short} · {s.subcategories.map((x) => cat.subcategories.find((y) => y.id === x)?.name.toLowerCase()).join(", ")}
          </div>
          <h1 className="h1">{s.name}{s.demo && <DemoPill />}{collectedNow && <span className="fresh-pill">собрано сейчас</span>}</h1>
          <div className="sub">
            <span>{isKnown(s.legal_name) ? s.legal_name.value : "юрлицо не указано"}</span>
            <span className="dot-sep" />
            {isKnown(s.inn) ? <span className="inn">ИНН <span className="num">{s.inn.value}</span> <StatusIcon status={isKnown(s.company) ? "found" : "claimed"} /></span> : <span className="miss inn">ИНН не найден <StatusIcon status="not_found" /></span>}
            <span className="dot-sep" />
            <span>{s.city}</span>
          </div>
        </div>
        <div className="card-score">
          {stop ? (
            <div className="stopped"><span className="label">Исключён из рекомендации</span><b>{stop.reason}</b></div>
          ) : (
            <>
              <div className="display num">{sc.total}<span className="unit">/100</span></div>
              <div className="sub">{place + 1}-й из {ranked.length} в категории</div>
            </>
          )}
        </div>
      </header>

      <div className="actions">
        <a className="btn pr" href={href("/shortlist", { draft: s.id })} onClick={() => actions.addShort(s.id)}>Написать — черновик запроса</a>
        <StarButton on={!!short} onClick={() => actions.toggleShort(s.id)} label={short ? "В шорт-листе" : "В шорт-лист"} />
        <button type="button" className={`btn sec${inCompare ? " on" : ""}`} aria-pressed={inCompare} onClick={toggleCompare}>{inCompare ? "✓ В сравнении" : "Сравнить"}</button>
        {inCompare && st.compare.length >= 2 && <a className="btn sec" href={href("/compare", { ids: st.compare.join(","), cat: cat.id, vol: q.volume, prio: base.prio })}>Открыть сравнение · {st.compare.length}</a>}
        <button type="button" className="btn ghost" onClick={() => setNotice("Обновление карточки — это живой сбор по одному поставщику (~30 с, ~1 ₽). В демо-версии сервер сбора не подключён.")}>Обновить данные</button>
      </div>
      {notice && <div className="notice" role="status">{notice}</div>}

      <div className="collected">
        <span><b className="num">{comp.found}</b> из {comp.total} полей найдено</span>
        <span className="dot-sep" />
        <span>{collectedNow ? "собрано сейчас" : `собрано ${dateRu(s.meta.collected_at)}`}</span>
        <span className="dot-sep" />
        <span>сайт · {sitePages} стр.{regs.length ? ` · ${regs.join(", ")}` : ""}</span>
        <Hint label="Как читать карточку">У каждого поля — знак и ссылка на источник: ● государственный реестр, ◐ со слов поставщика (подтвердить при первом контакте), ○ не найдено, ◇ оценка по рынку. Под значением с сайта — дословная цитата. Данные карт не храним — их условия это запрещают, поэтому только ссылка «на карте 2ГИС».</Hint>
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
              value={s.documents.declarations.value && (
                <ul className="decls">
                  {s.documents.declarations.value.map((d) => (
                    <li key={d.number}>
                      <DocGlyph size={24} />
                      <div>
                        <div>{d.product}</div>
                        <div className="q plain"><span className="num">{d.number}</span> · {d.status} до {monthYear(d.valid_to)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )} />
            {s.documents.marking ? (
              <FieldRow s={s} label="«Честный знак»" f={s.documents.marking} value={s.documents.marking.value && `участник: ${s.documents.marking.value.join(", ")}`} />
            ) : (
              <div className="field"><span className="k">«Честный знак»</span><div><div className="v miss">не применимо<Hint>Группы маркировки проверяем для рыбы и молочного; упаковка и бакалея в этих группах не маркируются.</Hint></div></div><span className="field-src">—</span></div>
            )}
            <FieldRow s={s} label="На сайте" f={s.documents.site_mentions} value={s.documents.site_mentions.value} />
          </section>

          <section>
            <h2 className="section-h">Товары</h2>
            <FieldRow s={s} label="Ассортимент" f={s.products} value={s.products.value?.join(", ")} />
          </section>

          <div className="card-bottom">
            {gaps.length > 0 && (
              <div className="panel cool">
                <div className="panel-h"><b>Что уточнить</b><a className="nowrap" href={href("/shortlist", { draft: s.id })} onClick={() => actions.addShort(s.id)}>в черновик →</a></div>
                <ul className="asks">{gaps.slice(0, 5).map((a) => <li key={a.key}><StatusIcon status={a.mark} /> {a.label}</li>)}</ul>
              </div>
            )}
            <div className="panel">
              <div className="panel-h"><b>Источники</b><span className="sub num">{s.meta.sources.length}</span></div>
              <ul className="sources">
                {s.meta.sources.map((src) => (
                  <li key={src.id}><span className={`kind k-${src.kind}`}>{sourceLabel(src)}</span><span>{src.title.replace(/^Сайт: /, "")}</span></li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <aside className="side">
          <div className="panel">
            <div className="panel-h">
              <b>{stop ? "Балл не считается" : `Почему ${sc.total}`}<Hint>Шкала 0–100 по каждому критерию. Неизвестное — треть шкалы: повод уточнить, а не приговор. Веса зависят от «что важнее».</Hint></b>
              <a href={href("/why", { ...base, id: s.id })}>Разбор →</a>
            </div>
            {!stop && <Gauge value={sc.total} size={220} label={`${place + 1}-й из ${ranked.length}`} />}
            {CRITS.map((cr) => (
              <Rule key={cr.id} value={sc.crits[cr.id].score} left={<><StatusIcon status={sc.crits[cr.id].mark} /> {cr.short}</>} right={`${Math.round(sc.crits[cr.id].score * 100)}`} />
            ))}
          </div>

          <div className="status">
            <div className="status-h">Компания {c ? <span className={`signal${c.status !== "active" ? " bad" : ""}`}>{{ active: "Действует", liquidating: "Ликвидируется", liquidated: "Ликвидирована", bankrupt: "Банкротство" }[c.status]}</span> : <span className="signal off">Не проверена</span>}</div>
            {c ? (
              <>
                <div className="status-big num">{ageYears(c.registered_at)}<span>{years(ageYears(c.registered_at)).replace(/^\d+ /, "")} на рынке</span></div>
                <div className="kv"><span>ОКВЭД {c.okved_main}</span><span>{c.okved_match ? "совпадает с категорией" : "не по профилю"}</span></div>
                {c.revenue.length > 0 && <div className="kv"><span>Выручка {c.revenue[c.revenue.length - 1].year}</span><span className="num">{num(c.revenue[c.revenue.length - 1].mln)} млн ₽{c.staff ? ` · ${c.staff} сотр.` : ""}</span></div>}
                <div className="kv"><span>Красные флаги</span><span>{c.flags.length ? c.flags.join(", ") : "нет"}</span></div>
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
              <MiniField label="Телефон" status={s.phones.status} value={s.phones.value?.join(", ")} strong />
              <MiniField label="Email" status={s.emails.status} value={s.emails.value?.join(", ")} />
              <MiniField label="Мессенджер" status={s.messengers.status} value={s.messengers.value?.join(", ")} />
              <MiniField label="Сайт" status={s.website.status} value={s.website.value?.replace("https://", "")} />
              <MiniField label="Адрес" status={s.address.status} value={s.address.value} />
              <MiniField label="Склад" status={s.presence.status} value={s.presence.value ? PRESENCE[s.presence.value] : null} />
            </div>
          </div>

          <Notes id={s.id} status={short?.status} note={short?.note ?? ""} noteAt={short?.note_at ?? null} />
        </aside>
      </div>
    </div>
  );
}

function MiniField({ label, status, value, strong }: { label: string; status: FieldStatus; value: string | null | undefined; strong?: boolean }) {
  return (
    <div className="mf-row">
      <span className="k">{label}</span>
      <span className={value ? (strong ? "strong" : "") : "miss"}>{value ?? "не найдено"}</span>
      <StatusIcon status={status} />
    </div>
  );
}

function Notes({ id, status, note, noteAt }: { id: string; status?: ContactStatus; note: string; noteAt: string | null }) {
  const [text, setText] = useState(note);
  useEffect(() => setText(note), [id, note]);
  return (
    <div className="panel notes">
      <div className="panel-h">
        <b>Мои заметки <StatusIcon status="user" /><Hint>Статус и заметка хранятся в этом браузере и видны и здесь, и в шорт-листе. Выбор статуса добавляет поставщика в шорт-лист.</Hint></b>
        {noteAt && <span className="sub">сохранено {new Date(noteAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}
      </div>
      <label className="label" htmlFor={`st-${id}`}>Статус контакта</label>
      <select id={`st-${id}`} className="input" value={status ?? ""} onChange={(e) => actions.setStatus(id, e.target.value as ContactStatus)}>
        {!status && <option value="">— не в шорт-листе —</option>}
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
