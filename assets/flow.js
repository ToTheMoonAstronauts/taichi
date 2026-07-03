/* Shared helpers for the post-paywall flow (payment + upsells + thank-you).
 * Reads the same ctc_quiz_session; accumulates an `order` array so that when real
 * Stripe is wired in, we know exactly which line items the user accepted.
 */
window.FLOW = (function () {
  const KEY = "ctc_quiz_session";
  function get() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
  function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
  function ensure(s) { s.order = s.order || []; return s; }

  function addItem(item) {
    const s = ensure(get());
    s.order = s.order.filter(o => o.id !== item.id); // avoid dupes if user goes back
    s.order.push(item); save(s); return s;
  }
  function removeItem(id) { const s = ensure(get()); s.order = s.order.filter(o => o.id !== id); save(s); return s; }
  function total() { return ensure(get()).order.reduce((a, o) => a + (o.amount || 0), 0); }
  function money(n) { return "$" + n.toFixed(2); }

  // 3-step header: active = 'setup' | 'offer' | 'plan'
  function stepHeader(active) {
    const steps = [["setup", "Complete setup"], ["offer", "Add offer"], ["plan", "Get the plan"]];
    const order = ["setup", "offer", "plan"]; const ai = order.indexOf(active);
    return `<div class="steps">` + steps.map((st, i) => {
      const state = i < ai ? "done" : i === ai ? "active" : "";
      const dot = i < ai ? "✓" : (i + 1);
      return `<div class="st ${state}"><span class="lbl">${st[1]}</span><span class="dot">${dot}</span></div>` +
        (i < 2 ? `<span class="bar2 ${i < ai ? "done" : ""}"></span>` : "");
    }).join("") + `</div>`;
  }

  return { get, save, addItem, removeItem, total, money, stepHeader };
})();
