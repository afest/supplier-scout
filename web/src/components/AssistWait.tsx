// Ожидание ответа модели (T-544): анимация, сменяющаяся фраза и секунды, как у живого сбора. Дольше обычного — пишем
// об этом и даём отменить, через полторы минуты запрос отменяется сам: кнопки не залипают.
// Общее для помощника и разбора плана закупа (T-546).
import { useEffect, useState } from "react";
import { clock } from "../lib/format.ts";

const SLOW_SEC = 20;                  // дольше — пишем, что модель задерживается, и даём отменить
const GIVE_UP_SEC = 90;               // столько не ждём: запрос отменяется, кнопки снова работают
const PHRASE_MS = 2500;

export function Wait({ since, phrases, abort, usual = "обычно 5–15 секунд" }: {
  since: number; phrases: string[]; abort: (reason: "timeout" | "cancel") => void; usual?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(iv);
  }, []);
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  const phrase = phrases[Math.floor(Math.max(0, now - since) / PHRASE_MS) % phrases.length];
  useEffect(() => { if (sec >= GIVE_UP_SEC) abort("timeout"); }, [sec]);
  return (
    <div className="assist-wait" role="status">
      <span className="assist-dots" aria-hidden="true"><i /><i /><i /></span>
      <b><span key={phrase} className="assist-phrase">{phrase}</span> · <span className="num" aria-hidden="true">{clock(sec)}</span></b>
      {sec >= SLOW_SEC
        ? <span className="sub">Дольше обычного: модель задерживается. <button type="button" className="link-btn" onClick={() => abort("cancel")}>Отменить</button></span>
        : <span className="sub">{usual}</span>}
    </div>
  );
}
