/* Funnel → Supabase edge functions (no supabase-js needed; plain fetch).
 * submit-quiz: save the lead/quiz. complete-order: fake-paid provisioning (no real Stripe).
 */
window.API = (function () {
  const URL = "https://pixtozeghxwiidpnloih.supabase.co";
  const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpeHRvemVnaHh3aWlkcG5sb2loIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MzgzNzgsImV4cCI6MjA5ODMxNDM3OH0.hJzlERAwXkbK8wV7R-NTcfa1YQ-TTk8R9nCM0Qdtblg";
  async function call(fn, body) {
    try {
      const r = await fetch(URL + "/functions/v1/" + fn, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": KEY, "Authorization": "Bearer " + KEY },
        body: JSON.stringify(body),
      });
      return await r.json();
    } catch (e) { return { error: String(e) }; }
  }
  return {
    submitQuiz: (session) => call("submit-quiz", { session }),
    completeOrder: (p) => call("complete-order", p),
    loginLink: (email) => call("login-link", { email }),
  };
})();
