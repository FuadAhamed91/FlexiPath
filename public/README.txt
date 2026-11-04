FlexiPath - how to open the built site

Open these files through a local web server, not by double-click.
A browser that opens index.html as a file:// page blocks the module
scripts and the stylesheet, so the page can not start (it shows a
"serve over HTTP" message instead).

One-line launcher, in this folder (needs Python 3):

  sh serve.sh                     (Linux / macOS)  ->  http://localhost:8000/
  serve.cmd                       (Windows, double-click)  ->  http://localhost:8000/

Or, from the project folder:

  npm run serve                                   ->  builds, then http://localhost:4173/
  npm run preview                                 ->  http://localhost:4173/
  python3 -m http.server 8000 --directory dist    ->  http://localhost:8000/

Then open index.html (landing page) or simulator.html (3D twin) from that address.
