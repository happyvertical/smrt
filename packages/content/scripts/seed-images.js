const apiUrl = process.argv[2] || 'http://localhost:5176';

const images = [
  {
    name: 'Mountain Landscape',
    sourceUri:
      'https://images.unsplash.com/photo-1506744626753-1fa28f6e2b99?q=80&w=1000&auto=format&fit=crop',
    mimeType: 'image/jpeg',
    width: 1000,
    height: 667,
    alt: 'Mountain landscape reflection',
    description: 'A beautiful reflection of mountains on a still lake.',
  },
  {
    name: 'Sunny Beach',
    sourceUri:
      'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?q=80&w=1000&auto=format&fit=crop',
    mimeType: 'image/jpeg',
    width: 1000,
    height: 667,
    alt: 'Sunny beach',
    description: 'White sandy beach with crystal clear waters.',
  },
  {
    name: 'City Skyline',
    sourceUri:
      'https://images.unsplash.com/photo-1478809846156-234204b6b6ec?q=80&w=1000&auto=format&fit=crop',
    mimeType: 'image/jpeg',
    width: 1000,
    height: 667,
    alt: 'City skyline at night',
    description: 'A bustling metropolis glowing after sunset.',
  },
];

async function seed() {
  console.log(`Seeding images to ${apiUrl}...`);

  for (const img of images) {
    try {
      const res = await fetch(`${apiUrl}/api/v1/images`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(img),
      });

      if (!res.ok) {
        console.error(
          `Failed to create ${img.name}: ${res.statusText} - ${await res.text()}`,
        );
      } else {
        const data = await res.json();
        console.log(`Created: ${img.name} (${data.id})`);
      }
    } catch (e) {
      console.error(`Error creating ${img.name}:`, e.message);
    }
  }

  console.log('Finished seeding images.');
}

seed();
