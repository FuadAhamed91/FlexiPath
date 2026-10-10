FlexiPath - how to open the built site

Open these files through a local web server, not by double-click.
A browser that opens index.html as a file:// page blocks the module
scripts and the stylesheet, so the page stays blank.

From the project folder, run one of:

  npm run preview                                 ->  http://localhost:4173/
  python3 -m http.server 8000 --directory dist    ->  http://localhost:8000/

Then open index.html (landing page) or simulator.html (3D twin) from that address.
