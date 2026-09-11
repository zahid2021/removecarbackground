/**
 * Landing hero — lightweight Three.js 3D stage (car billboard + showroom floor).
 * Loaded only on /. Falls back silently if WebGL unavailable.
 */
(function () {
  const stage = document.getElementById("hero3d");
  if (!stage || typeof THREE === "undefined") return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const w0 = () => stage.clientWidth || window.innerWidth;
  const h0 = () => stage.clientHeight || Math.max(420, window.innerHeight * 0.72);

  let renderer, scene, camera, carMesh, frameId;
  let pointerX = 0;
  let pointerY = 0;
  let targetRX = 0;
  let targetRY = 0;

  function init() {
    const width = w0();
    const height = h0();

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.className = "hero-3d-canvas";
    renderer.domElement.setAttribute("aria-hidden", "true");
    stage.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    camera.position.set(0, 1.15, 4.6);

    const ambient = new THREE.AmbientLight(0xffffff, 0.72);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(3.5, 6, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xff6b78, 0.45);
    rim.position.set(-4, 2, -2);
    scene.add(rim);

    // Showroom floor with perspective grid
    const floorGeo = new THREE.PlaneGeometry(18, 18, 1, 1);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x121820,
      metalness: 0.65,
      roughness: 0.35,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.85;
    scene.add(floor);

    const grid = new THREE.GridHelper(18, 36, 0xe11d2e, 0x2a3544);
    grid.position.y = -0.84;
    const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMats.forEach((m) => {
      m.transparent = true;
      m.opacity = 0.35;
    });
    scene.add(grid);

    // Soft glow ring under car
    const ringGeo = new THREE.RingGeometry(1.1, 1.55, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xe11d2e,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.83;
    scene.add(ring);

    const loader = new THREE.TextureLoader();
    const carUrl = stage.dataset.carSrc || "/images/demo/after-full.jpg";
    loader.load(
      carUrl,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        const aspect = (tex.image && tex.image.width && tex.image.height)
          ? tex.image.width / tex.image.height
          : 16 / 9;
        const planeH = 2.05;
        const planeW = planeH * aspect;
        const geo = new THREE.PlaneGeometry(planeW, planeH);
        const mat = new THREE.MeshStandardMaterial({
          map: tex,
          transparent: true,
          metalness: 0.12,
          roughness: 0.55,
        });
        carMesh = new THREE.Mesh(geo, mat);
        carMesh.position.set(0, 0.2, 0);
        scene.add(carMesh);
      },
      undefined,
      () => {
        stage.classList.add("hero-3d-fallback");
      }
    );

    stage.addEventListener(
      "pointermove",
      (e) => {
        const r = stage.getBoundingClientRect();
        pointerX = ((e.clientX - r.left) / r.width) * 2 - 1;
        pointerY = ((e.clientY - r.top) / r.height) * 2 - 1;
      },
      { passive: true }
    );

    window.addEventListener("resize", onResize, { passive: true });
    animate();
  }

  function onResize() {
    if (!renderer || !camera) return;
    const width = w0();
    const height = h0();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function animate() {
    frameId = requestAnimationFrame(animate);
    const t = performance.now() * 0.001;
    targetRY = pointerX * 0.28;
    targetRX = -pointerY * 0.12;

    if (carMesh) {
      if (reduceMotion) {
        carMesh.rotation.y = 0.12;
        carMesh.position.y = 0.2;
      } else {
        carMesh.rotation.y += (targetRY + Math.sin(t * 0.35) * 0.08 - carMesh.rotation.y) * 0.06;
        carMesh.rotation.x += (targetRX - carMesh.rotation.x) * 0.06;
        carMesh.position.y = 0.2 + Math.sin(t * 0.9) * 0.05;
      }
    }

    camera.position.x += (pointerX * 0.25 - camera.position.x) * 0.04;
    camera.lookAt(0, 0.15, 0);
    renderer.render(scene, camera);
  }

  // Boot after layout
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
