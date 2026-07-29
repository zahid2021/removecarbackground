/* API host:
   - Local / combined web service → same origin
   - Static CDN frontend → free Python API on Render
*/
(function () {
  var host = window.location.hostname;
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "removecarbackground.onrender.com"
  ) {
    window.RCB_API = window.location.origin;
  } else {
    window.RCB_API = "https://removecarbackground.onrender.com";
  }
})();
