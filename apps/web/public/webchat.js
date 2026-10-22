/*
 * Infinite Abyss · webchat embebible.
 *   <script src="https://CASINO/webchat.js" data-operator="<operatorId>" async></script>
 * Añade una burbuja flotante que abre el chat (/webchat) en un iframe.
 */
(function () {
  var script = document.currentScript;
  if (!script || window.__abyssWebchat) return;
  window.__abyssWebchat = true;
  var origin = new URL(script.src).origin;
  var op = script.getAttribute("data-operator") || "";
  var color = script.getAttribute("data-color") || "#f4b73f";
  var open = false;

  var frame = document.createElement("iframe");
  frame.src = origin + "/webchat?op=" + encodeURIComponent(op);
  frame.title = "Chat de soporte";
  frame.setAttribute("allow", "clipboard-write");
  frame.style.cssText = "position:fixed;right:20px;bottom:92px;width:min(380px,calc(100vw - 40px));height:min(560px,calc(100vh - 120px));border:0;border-radius:16px;box-shadow:0 30px 80px -20px rgba(0,0,0,.6);z-index:2147483646;display:none;background:#050d1c";

  var btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Abrir chat de soporte");
  btn.style.cssText = "position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;z-index:2147483647;display:grid;place-items:center;box-shadow:0 10px 30px -8px rgba(0,0,0,.5);background:" + color;
  var chatIcon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1a1205" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
  var closeIcon = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a1205" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  btn.innerHTML = chatIcon;
  btn.addEventListener("click", function () {
    open = !open;
    frame.style.display = open ? "block" : "none";
    btn.innerHTML = open ? closeIcon : chatIcon;
    btn.setAttribute("aria-label", open ? "Cerrar chat" : "Abrir chat de soporte");
  });

  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(btn);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
