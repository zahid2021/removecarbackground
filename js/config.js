/* API host:
   - Local / combined web service → same origin
   - Custom domain + static CDN → free Python API on Render
*/
(function () {
  var host = window.location.hostname;
  var apiHosts = {
    "removecarbackground.onrender.com": true,
    "localhost": true,
    "127.0.0.1": true,
  };
  if (apiHosts[host]) {
    window.RCB_API = window.location.origin;
  } else {
    // removecarbackground.com, www, rcb-demo, etc.
    window.RCB_API = "https://removecarbackground.onrender.com";
  }
})();
