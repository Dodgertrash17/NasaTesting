// Education page content. Edit text here: the page builds itself from this list.
// Each topic has an `intro` (shown when the topic is clicked) and `subs` (subtabs).
// Links between pages: use "#topic-id/sub-id".

const LEARN = [
  {
    id: 'basics',
    title: 'Basic Astronomy',
    summary: 'How astronomers point at the sky, and why some things in it move.',
    intro: `
      <p>You don't need any background to use SkyBlink, but a few ideas make the images much more fun to read.
         Start here if words like "declination" or "infrared" are new to you.</p>`,
    subs: [
      {
        id: 'coordinates', title: 'Sky coordinates (RA & Dec)', summary: 'The sky\'s version of latitude and longitude.',
        body: `
          <p>Astronomers imagine the sky as a giant sphere around Earth and draw a grid on it, just like latitude and longitude on a globe.</p>
          <ul>
            <li><strong>Declination (Dec)</strong> is like latitude: how far north or south of the celestial equator something is, from +90° (above the North Pole) to −90°.</li>
            <li><strong>Right Ascension (RA)</strong> is like longitude: how far east around the sky. It's usually written in <em>hours</em> (0h to 24h), because the sky turns once a day. 1 hour = 15°.</li>
          </ul>
          <p>So WISE 0855 at RA 08h55m10.8s, Dec −07°14′43″ sits a little south of the celestial equator, about a third of the way around the sky.</p>
          <div class="callout"><p><strong>Tip:</strong> the search tool accepts both styles: <code>133.795</code> (degrees) or <code>08h55m10s</code> (hours).</p></div>
          <h2>How small is an arcsecond?</h2>
          <p>A degree splits into 60 arcminutes (′), and an arcminute into 60 arcseconds (″). One arcsecond is about the size of a coin seen from 4 km away. Most motions you'll see in SkyBlink are a few arcseconds per year.</p>`,
      },
      {
        id: 'light', title: 'Light & infrared', summary: 'Why SPHEREx looks at colors our eyes can\'t see.',
        body: `
          <p>Visible light is a tiny slice of the electromagnetic spectrum. Just beyond red is <strong>infrared</strong>, light with longer wavelengths that we feel as heat but can't see.</p>
          <p>SPHEREx sees near-infrared light from 0.75 to 5 micrometers (µm). That range is great for:</p>
          <ul>
            <li><strong>Cold objects</strong> like brown dwarfs, which give off almost no visible light but glow in infrared.</li>
            <li><strong>Seeing through dust</strong>, which blocks visible light but lets infrared through.</li>
            <li><strong>Chemistry</strong>: molecules like water, carbon dioxide and methane absorb specific infrared wavelengths, leaving fingerprints in an object's spectrum.</li>
          </ul>`,
      },
      {
        id: 'motion', title: 'Why things move', summary: 'Orbits, proper motion and parallax.',
        body: `
          <p>Everything in space is moving. In images taken months apart, three kinds of motion show up:</p>
          <ul>
            <li><strong>Orbital motion:</strong> asteroids and comets orbit the Sun and can move a lot between images, sometimes across the whole frame.</li>
            <li><strong>Proper motion:</strong> nearby stars and brown dwarfs travel through the galaxy. Barnard's Star moves about 10″ per year, the fastest of any star.</li>
            <li><strong>Parallax:</strong> as Earth orbits the Sun, nearby objects seem to shift back and forth, like your thumb jumping when you blink one eye and then the other. The closer the object, the bigger the shift, so parallax measures distance.</li>
          </ul>
          <div class="callout"><p><strong>Set expectations:</strong> SPHEREx pixels are about 6 arcseconds wide, so even fast stars may move only a pixel or two over a couple of years. Asteroids move much more.</p></div>`,
      },
      {
        id: 'objects', title: 'What\'s out there', summary: 'Stars, brown dwarfs, asteroids, variables.',
        body: `
          <table>
            <tr><th>Object</th><th>What it is</th><th>How it looks when blinked</th></tr>
            <tr><td>Asteroid / comet</td><td>Small body orbiting the Sun</td><td>Big jump, or present in one image only</td></tr>
            <tr><td>Brown dwarf</td><td>"Failed star", too light to burn hydrogen</td><td>Faint, red, slow steady drift</td></tr>
            <tr><td>Nearby star</td><td>A star within a few dozen light-years</td><td>Bright, slow steady drift</td></tr>
            <tr><td>Variable star</td><td>Star whose brightness changes</td><td>Stays put, gets brighter and dimmer</td></tr>
            <tr><td>Galaxy / distant star</td><td>Very far away</td><td>Doesn't move at all</td></tr>
          </table>`,
      },
    ],
  },
  {
    id: 'spherex',
    title: 'The SPHEREx Mission',
    summary: 'NASA\'s infrared all-sky mapper.',
    intro: `
      <p><strong>SPHEREx</strong> stands for <em>Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer</em>.
         It launched on March 11, 2025 and began mapping the sky in May 2025.</p>
      <p>Its main science goals are cosmology (a 3D map of hundreds of millions of galaxies), the history of light from all galaxies,
         and the ices that become planets. But because it photographs <em>everything</em>, its data is also a treasure trove for spotting things that move or change.</p>`,
    subs: [
      {
        id: 'overview', title: 'Mission overview', summary: 'Key facts at a glance.',
        body: `
          <table>
            <tr><th>Launched</th><td>March 11, 2025</td></tr>
            <tr><th>Survey began</th><td>May 2025</td></tr>
            <tr><th>Wavelengths</th><td>0.75 – 5.0 µm (near-infrared)</td></tr>
            <tr><th>Spectral bands</th><td>102</td></tr>
            <tr><th>Pixel size</th><td>about 6.2 arcseconds</td></tr>
            <tr><th>Sky coverage</th><td>Entire sky every ~6 months</td></tr>
            <tr><th>Telescope</th><td>20 cm mirror, wide field of view</td></tr>
          </table>
          <p>Operated by NASA's Jet Propulsion Laboratory (JPL) with Caltech. Data is published through NASA/IPAC's Infrared Science Archive (IRSA).</p>`,
      },
      {
        id: 'bands', title: 'Seeing in 102 colors', summary: 'How one camera takes a spectrum of the whole sky.',
        body: `
          <p>Most cameras take a picture in a few colors. SPHEREx splits its light into <strong>102 narrow wavelength bands</strong>, enough to measure a rough spectrum of every object in the sky.</p>
          <p>It does this with <strong>linear variable filters</strong>: the filter in front of each of its six detectors changes color from one edge to the other. So in a single exposure, different parts of the image see different wavelengths.</p>
          <p>As the telescope steps across the sky, each star lands on a different part of the filter, and gets measured at a different wavelength. Put all the steps together and you get a spectrum.</p>
          <div class="callout"><p><strong>What that means for blinking:</strong> two images of the same spot can differ because of <em>wavelength</em>, not only time. A fair comparison uses images at similar wavelengths, or adds many bands together.</p></div>
          <h2>Six detectors</h2>
          <p>The 102 bands are spread across six detector arrays, roughly 17 bands each, from 0.75 µm on the short end to 5.0 µm on the long end. The longest-wavelength detectors have finer color resolution, tuned to spot ices.</p>
          <p><a href="dome.html?poi=rhooph">See it in the Sky Dome →</a> Sweep through all 102 bands and watch ice absorption appear in a star-forming cloud.</p>`,
      },
      {
        id: 'survey', title: 'How it scans the sky', summary: 'Every patch, twice a year.',
        body: `
          <p>SPHEREx orbits Earth over the poles. As Earth goes around the Sun, the telescope's view sweeps around the sky, covering all of it in about six months.</p>
          <p>That means every patch of sky gets visited about <strong>twice a year</strong>. Comparing visits is what makes moving objects visible, and is exactly what SkyBlink does.</p>
          <p>The sky near the ecliptic poles is visited much more often, so those regions have the deepest, most-repeated images.</p>`,
      },
      {
        id: 'data', title: 'Where the data comes from', summary: 'IRSA and data releases.',
        body: `
          <p>Processed SPHEREx images are released to the public through <a href="https://irsa.ipac.caltech.edu/" target="_blank" rel="noopener">NASA/IPAC IRSA</a>. New data arrives regularly, so the same patch of sky gains new dates over time.</p>
          <p>SkyBlink is built so new data releases can be added without changing the website, just by adding new data files.</p>`,
      },
    ],
  },
  {
    id: 'planetx',
    title: 'Planet X: history & search',
    summary: 'Two centuries of hunting for unseen worlds.',
    intro: `
      <p>"Planet X" is the name for a hypothetical unknown planet in the outer solar system. The search for it has a long history, and it's the reason the blinking technique exists.</p>`,
    subs: [
      {
        id: 'neptune', title: 'Neptune: found by math (1846)', summary: 'A planet predicted before it was seen.',
        body: `
          <p>In the early 1800s, Uranus wasn't following the path that gravity predicted. Urbain Le Verrier (and independently John Couch Adams) calculated that an unseen planet must be tugging on it.</p>
          <p>On September 23, 1846, Johann Galle pointed a telescope where Le Verrier said to look and found <strong>Neptune</strong> within a degree of the prediction.</p>`,
      },
      {
        id: 'pluto', title: 'Lowell, Tombaugh & Pluto (1930)', summary: 'The first great "blink" discovery.',
        body: `
          <p>Percival Lowell believed yet another planet, which he named <strong>Planet X</strong>, lay beyond Neptune. He searched until his death in 1916.</p>
          <p>In 1929 Lowell Observatory hired a young Clyde Tombaugh to continue. He photographed the same areas of sky a few nights apart, then used a <strong>blink comparator</strong>, a machine that flipped rapidly between two photographic plates.</p>
          <p>Stars stayed still. On February 18, 1930, Tombaugh noticed one faint dot jumping back and forth: <strong>Pluto</strong>.</p>
          <div class="callout"><p>SkyBlink is a digital blink comparator: the same idea, with infrared images of the entire sky.</p></div>`,
      },
      {
        id: 'planet9', title: 'Planet Nine today', summary: 'The modern hunt.',
        body: `
          <p>Pluto turned out to be too small to be Planet X, and Neptune's orbit was later explained without an extra planet. But the idea came back.</p>
          <p>In 2016, Konstantin Batygin and Mike Brown noticed that several very distant icy objects have strangely lined-up orbits. They proposed a "<strong>Planet Nine</strong>" several times Earth's mass, far beyond Neptune, could be the cause.</p>
          <p>It hasn't been found. If it exists, it's faint, cold and slow-moving: the kind of thing infrared surveys are well placed to spot.</p>`,
      },
      {
        id: 'citizen', title: 'Citizen scientists', summary: 'Volunteers who found real worlds.',
        body: `
          <p>The project <a href="https://backyardworlds.org" target="_blank" rel="noopener">Backyard Worlds: Planet 9</a> invited the public to blink images from NASA's WISE infrared telescope. Volunteers have found thousands of brown dwarf candidates, including some of the coldest known.</p>
          <p>Most known comets and brown dwarfs were found this way. SkyBlink brings the same approach to SPHEREx's brand-new data.</p>`,
      },
    ],
  },
  {
    id: 'methods',
    title: 'Data collection methods',
    summary: 'How telescopes turn light into discoveries.',
    intro: `<p>From detectors to spectra to exoplanets: how astronomers gather and use their data.</p>`,
    subs: [
      {
        id: 'imaging', title: 'Digital imaging', summary: 'Pixels, exposures and noise.',
        body: `
          <p>A telescope's detector is a grid of pixels that count incoming light. Infrared detectors like SPHEREx's must be kept extremely cold, or their own heat would swamp the signal.</p>
          <p>Every image has <strong>noise</strong>, random speckle from the detector and sky. Faint objects can hide in it. Adding several images together (<em>stacking</em>) makes faint things stand out.</p>`,
      },
      {
        id: 'blinking', title: 'Blinking & difference images', summary: 'Two ways to find change.',
        body: `
          <ul>
            <li><strong>Blinking:</strong> flip between images quickly. Your eye is very good at noticing something jump.</li>
            <li><strong>Difference images:</strong> subtract one image from another. Anything that didn't change cancels to grey; things that moved show up as a bright and dark pair.</li>
          </ul>
          <p>SkyBlink offers both. Try the <em>Difference</em> button in the viewer.</p>`,
      },
      {
        id: 'spectra', title: 'Spectroscopy', summary: 'Reading an object\'s chemistry.',
        body: `
          <p>A <strong>spectrum</strong> shows how bright something is at each wavelength. Dips reveal which molecules are absorbing light, and the overall shape tells you temperature.</p>
          <p>For example, cold brown dwarfs are dim near 3.3 µm, where methane absorbs, and bright near 4–5 µm. With 102 bands, SPHEREx can measure spectra like this for objects across the whole sky.</p>`,
      },
      {
        id: 'exoplanets', title: 'Exoplanet detection', summary: 'Five ways to find planets around other stars.',
        body: `
          <table>
            <tr><th>Method</th><th>What's measured</th></tr>
            <tr><td>Transit</td><td>A star dims slightly as a planet passes in front</td></tr>
            <tr><td>Radial velocity</td><td>A star wobbles toward and away from us, shifting its spectrum</td></tr>
            <tr><td>Direct imaging</td><td>A photo of the planet itself, with the star's glare blocked</td></tr>
            <tr><td>Microlensing</td><td>A planet's gravity briefly magnifies a background star</td></tr>
            <tr><td>Astrometry</td><td>A star's position wobbles on the sky</td></tr>
          </table>
          <p>Transits and radial velocity have found most known exoplanets. SPHEREx isn't a planet-finder, but its spectra can help study the ices that planets form from.</p>`,
      },
    ],
  },
  {
    id: 'looking',
    title: 'What to look for in images',
    summary: 'A field guide for blinkers.',
    intro: `<p>Not everything that changes is a discovery. Here's how to tell real movers from tricks of the camera.</p>`,
    subs: [
      {
        id: 'movers', title: 'Real movers', summary: 'Signs you\'ve found something.',
        body: `
          <ul>
            <li>The dot <strong>moves in a straight line</strong> across three or more dates.</li>
            <li>It moves <strong>the same amount</strong> between equally-spaced dates.</li>
            <li>It looks like the stars around it: same round shape, not sharp or streaky.</li>
          </ul>
          <p>A dot that drifts slowly and steadily over years is likely a nearby star or brown dwarf. One that's in a single image only is often an asteroid.</p>`,
      },
      {
        id: 'variables', title: 'Variable stars', summary: 'Same place, changing brightness.',
        body: `
          <p>A star that stays put but grows brighter and dimmer is a <strong>variable star</strong>. R Draconis, one of our test targets, swells and fades over about 8 months. RW Aurigae is a young star that dims unpredictably as dust passes in front of it.</p>`,
      },
      {
        id: 'artifacts', title: 'False alarms', summary: 'Things that fool the eye.',
        body: `
          <ul>
            <li><strong>Cosmic rays:</strong> sharp single-pixel hits in one image only.</li>
            <li><strong>Saturation & bleed:</strong> very bright stars can overflow pixels and leave streaks or rings.</li>
            <li><strong>Ghosts & glints:</strong> reflections inside the telescope near bright stars.</li>
            <li><strong>Wavelength changes:</strong> with SPHEREx, an object can look brighter just because the image was taken at a different wavelength.</li>
            <li><strong>Image edges:</strong> noisier and sometimes misaligned.</li>
          </ul>
          <p>Data files can include <em>flags</em> that mark known problems. SkyBlink shows them in the Raw Data panel when available.</p>`,
      },
      {
        id: 'tips', title: 'Tips for using SkyBlink', summary: 'Get the most from the viewer.',
        body: `
          <ul>
            <li>Start with <strong>Blink</strong> at normal speed, then step through dates with <kbd>←</kbd> <kbd>→</kbd>.</li>
            <li>Switch to <strong>Difference</strong> to make small changes pop.</li>
            <li>Raise <strong>Contrast</strong> to see faint objects; try <strong>Invert</strong>, as some people find dark-on-light easier.</li>
            <li>Hover over the image to read pixel values in the <strong>Raw Data</strong> panel.</li>
            <li>Use <strong>Copy link</strong> to share exactly what you're looking at.</li>
          </ul>`,
      },
    ],
  },
  {
    id: 'glossary',
    title: 'Glossary',
    summary: 'Quick definitions.',
    intro: `
      <table>
        <tr><th>Arcsecond (″)</th><td>1/3600 of a degree. A tiny angle on the sky.</td></tr>
        <tr><th>Brown dwarf</th><td>An object between a planet and a star in mass, too small to sustain hydrogen fusion.</td></tr>
        <tr><th>Declination</th><td>Sky "latitude", from +90° to −90°.</td></tr>
        <tr><th>Field of view</th><td>How much sky an image covers.</td></tr>
        <tr><th>Infrared</th><td>Light with longer wavelengths than red; invisible to our eyes.</td></tr>
        <tr><th>MJD</th><td>Modified Julian Date, a day count astronomers use for timestamps.</td></tr>
        <tr><th>Parallax</th><td>Apparent shift of nearby objects as Earth orbits the Sun.</td></tr>
        <tr><th>Proper motion</th><td>An object's real motion across the sky, usually in arcseconds per year.</td></tr>
        <tr><th>Right Ascension</th><td>Sky "longitude", usually in hours (0–24h).</td></tr>
        <tr><th>Spectrum</th><td>Brightness measured at many wavelengths.</td></tr>
        <tr><th>Micrometer (µm)</th><td>One millionth of a meter, the unit for infrared wavelengths.</td></tr>
      </table>`,
    subs: [],
  },
];
