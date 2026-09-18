const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

function getTodayIST() {
  const now = new Date();
  const istTime = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return istTime.toISOString().split('T')[0];
}

// Use IST date for topic rotation too
function getISTDate() {
  const now = new Date();
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
}

async function generateWithAI(topic, usedAnswers) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{
        role: "user",
        content: `You must NOT pick a topic from these domains, since they have already been used recently: Mathematics, Physics, Mechanical Engineering, Food, Cooking, Cuisine.

You are creating a daily riddle-style word puzzle. The DIFFICULTY should suit a sharp college-level solver — but the TOPIC must come from a domain you have not already used.

Step 1 — Pick a topic:
- Pick ONE topic from a domain completely different from the banned list above — think outside academics and food entirely: it could be something from sport, travel, an internet phenomenon, a craft, a historical event, an animal, a place, a tool, a tradition, an art form, a game, a myth, an object, a profession, or literally anything else that exists
- Be specific, not generic
- If your first instinct is anything close to the banned domains, discard it and pick something further away

Step 2 — Pick an answer:
- ONE common, well-known term related to that topic, 4-6 letters, only alphabets, no spaces
- Do NOT use any of these already-used answers: ${[...usedAnswers].join(', ')}

Step 3 — Write the riddle:
- Write exactly ONE clue line as the question — not multiple lines, not a list, just one single riddle sentence
- The line must not be a dictionary-style definition — make it require real inference, not simple recall
- Assume the solver is sharp and college-educated — the clue can be genuinely challenging and layered, regardless of topic
- Avoid the answer word or its obvious synonym in the line
- Should take real thought (30-90 seconds), not be instantly obvious, and not require obscure trivia nobody would know

Return ONLY valid JSON, no explanation, no markdown:

{
  "answer": "...",
  "question": "Q. ...",
  "category": "..."
}`
      }],
      temperature: 0.9
    })
  });

  const data = await res.json();
  console.log("AI RAW:", JSON.stringify(data));

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("No AI response");

  const answerMatch   = text.match(/"answer"\s*:\s*"([^"]+)"/);
  const questionMatch = text.match(/"question"\s*:\s*"([^"]+)"/);
  const categoryMatch = text.match(/"category"\s*:\s*"([^"]+)"/);

  if (!answerMatch || !questionMatch || !categoryMatch) {
    throw new Error("Invalid AI output format");
  }

  const answer = answerMatch[1].toLowerCase().trim();

  // Validate: letters only, 4-10 chars
  if (!/^[a-z]{4,10}$/.test(answer)) {
    throw new Error(`Invalid word format: "${answer}"`);
  }

  // Duplicate check
  if (usedAnswers.has(answer)) {
    throw new Error(`Duplicate answer: "${answer}"`);
  }

  return {
    answer,
    question: questionMatch[1].trim().replace(/\\n/g, '\n'),
    category: categoryMatch[1].trim()
  };
}

async function run() {
  const today = getTodayIST();
  console.log("TODAY DATE (IST):", today);

  const editions = [
    { suffix: "m", label: "Morning Edition" },
    { suffix: "a", label: "Afternoon Edition" },
    { suffix: "e", label: "Evening Edition" },
  ];
  const todayDocRefs = editions.map(edition => ({
    ...edition,
    id: `${today}-${edition.suffix}`,
    ref: db.collection('sciwordle_daily').doc(`${today}-${edition.suffix}`)
  }));
  const todayDocs = await Promise.all(todayDocRefs.map(item => item.ref.get()));
  const hasAllEditions = todayDocs.every(doc => doc.exists);
  if (hasAllEditions) {
    console.log("All editions already exist for today:", today);
    return;
  }

  // Topic rotation using IST date
  const topics = [
    "Physics", "Chemistry", "Biology",
    "Astronomy", "Earth Science", "General Science"
  ];
  const topic = topics[getISTDate().getDate() % topics.length];
  console.log("Selected topic:", topic);

  // Load used answers once
  const existingDocs = await db.collection('sciwordle_daily').get();
  const usedAnswers = new Set(
    existingDocs.docs.map(d => d.data().answer).filter(Boolean)
  );
  console.log("Used answers so far:", usedAnswers.size);

  const fallbacks = [
    { answer: "nucleus",   question: "Q. I am the control centre of a cell. What am I?",           category: "Biology"  },
    { answer: "magnet",    question: "Q. I attract iron and have north and south poles. What am I?", category: "Physics"  },
    { answer: "oxygen",    question: "Q. I am the gas humans breathe in to survive. What am I?",    category: "Chemistry" },
    { answer: "eclipse",   question: "Q. I happen when one celestial body blocks another. What am I?", category: "Astronomy" },
    { answer: "erosion",   question: "Q. I am the wearing away of rock and soil by wind or water. What am I?", category: "Earth Science" },
    { answer: "photon",    question: "Q. I am a particle of light with no mass. What am I?",        category: "Physics"  },
    { answer: "enzyme",    question: "Q. I speed up chemical reactions in living organisms. What am I?", category: "Biology"  },
    { answer: "planet",    question: "Q. I orbit a star and can have moons. What am I?", category: "Astronomy"  },
    { answer: "matter",    question: "Q. I am anything that has mass and occupies space. What am I?", category: "General Science"  },
  ];

  for (let i = 0; i < todayDocRefs.length; i++) {
    const slot = todayDocRefs[i];
    const slotDoc = todayDocs[i];
    if (slotDoc.exists) {
      const existingAnswer = slotDoc.data()?.answer;
      if (existingAnswer) usedAnswers.add(existingAnswer);
      console.log(`Skipping existing ${slot.label}: ${slot.id}`);
      continue;
    }

    let question = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        console.log(`${slot.label} AI attempt ${attempt}...`);
        question = await generateWithAI(topic, usedAnswers);
        console.log(`${slot.label} AI succeeded:`, question);
        break;
      } catch (e) {
        console.log(`${slot.label} attempt ${attempt} failed: ${e.message}`);
      }
    }

    if (!question) {
      question = fallbacks.find(f => !usedAnswers.has(f.answer)) || fallbacks[0];
      console.log(`${slot.label} using fallback:`, question);
    }

    usedAnswers.add(question.answer);
    await slot.ref.set({
      ...question,
      slot: slot.suffix,
      edition: slot.label,
      generatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Created ${slot.label}: ${slot.id}`);
    console.log("   answer:  ", question.answer);
    console.log("   question:", question.question);
    console.log("   category:", question.category);
  }
}

run();
