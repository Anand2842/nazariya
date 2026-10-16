/*! Nazariya embed SDK v1.0.0 — embed interactive 3D/360° tours and control them from your page.
 *
 *   <div id="tour" style="height:560px"></div>
 *   <script src="https://YOUR-NAZARIYA-HOST/sdk/nazariya.js"></script>
 *   <script>
 *     var tour = Nazariya.embed("#tour", { space: "abc123xyz0", room: null, view: "auto", autostart: false });
 *     tour.on("ready", function (e) { console.log(e.rooms); });
 *     tour.on("roomchange", function (e) { console.log(e.label); });
 *     tour.goToRoom("Kitchen");   // by name, id or index
 *     tour.setView("360");        // "3d" | "360" | "photos"
 *   </script>
 *
 * Or without JavaScript: <div data-nazariya-space="abc123xyz0" style="height:560px"></div>
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var ORIGIN = script && script.src ? new URL(script.src).origin : window.location.origin;

  function Tour(el, opts) {
    var self = this;
    this.opts = opts || {};
    this.listeners = {};
    this.ready = false;
    this.queue = [];
    var q = [];
    if (this.opts.room) q.push("room=" + encodeURIComponent(this.opts.room));
    if (this.opts.view && this.opts.view !== "auto") q.push("view=" + encodeURIComponent(this.opts.view));
    if (this.opts.autostart) q.push("autostart=1");
    if (this.opts.showRooms === false) q.push("rooms=0");
    var iframe = document.createElement("iframe");
    iframe.src = ORIGIN + "/embed/" + encodeURIComponent(this.opts.space) + (q.length ? "?" + q.join("&") : "");
    iframe.title = this.opts.title || "3D tour";
    iframe.setAttribute("allow", "fullscreen; gyroscope; accelerometer; xr-spatial-tracking");
    iframe.setAttribute("allowfullscreen", "");
    iframe.setAttribute("loading", this.opts.lazy === false ? "eager" : "lazy");
    iframe.style.cssText = "width:100%;height:" + (this.opts.height ? this.opts.height + "px" : "100%") + ";min-height:320px;border:0;border-radius:" + (this.opts.radius == null ? 12 : this.opts.radius) + "px;display:block";
    el.innerHTML = "";
    el.appendChild(iframe);
    this.iframe = iframe;
    this._onMessage = function (e) {
      if (e.source !== iframe.contentWindow || e.origin !== ORIGIN) return;
      var d = e.data;
      if (!d || d.source !== "nazariya") return;
      if (d.type === "ready") {
        self.ready = true;
        self.rooms = d.rooms || [];
        while (self.queue.length) self._send(self.queue.shift());
      }
      self._fire(d.type, d);
    };
    window.addEventListener("message", this._onMessage);
  }

  Tour.prototype._send = function (msg) {
    if (!this.ready) return this.queue.push(msg);
    msg.target = "nazariya";
    this.iframe.contentWindow.postMessage(msg, ORIGIN);
  };
  Tour.prototype._fire = function (type, data) {
    (this.listeners[type] || []).forEach(function (fn) {
      try { fn(data); } catch (err) { console.error(err); }
    });
  };
  /** Events: ready, start, roomchange, viewchange, hotspotclick, error */
  Tour.prototype.on = function (type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
    return this;
  };
  Tour.prototype.goToRoom = function (room) { this._send({ command: "goToRoom", room: room }); return this; };
  Tour.prototype.setView = function (view) { this._send({ command: "setView", view: view }); return this; };
  Tour.prototype.start = function () { this._send({ command: "start" }); return this; };
  Tour.prototype.destroy = function () {
    window.removeEventListener("message", this._onMessage);
    if (this.iframe && this.iframe.parentNode) this.iframe.parentNode.removeChild(this.iframe);
  };

  function embed(target, opts) {
    var el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) throw new Error("Nazariya.embed: element not found: " + target);
    if (!opts || !opts.space) throw new Error("Nazariya.embed: 'space' is required");
    return new Tour(el, opts);
  }

  function autoInit() {
    var nodes = document.querySelectorAll("[data-nazariya-space]:not([data-nazariya-ready])");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      n.setAttribute("data-nazariya-ready", "1");
      embed(n, { space: n.getAttribute("data-nazariya-space"), room: n.getAttribute("data-room"), view: n.getAttribute("data-view"), autostart: n.getAttribute("data-autostart") === "1" });
    }
  }

  window.Nazariya = { embed: embed, version: "1.0.0" };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoInit);
  else autoInit();
})();
