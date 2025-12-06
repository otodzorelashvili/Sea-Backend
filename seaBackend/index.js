import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// IMAGE UPLOAD → ImgHippo
// ==========================================
app.post("/upload-image", upload.single("image"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No image uploaded" });

  try {
    const form = new FormData();
    form.append("api_key", "906db25b5178e738f740b214d6688467");
    form.append("file", file.buffer, file.originalname);

    const response = await fetch("https://api.imghippo.com/v1/upload", {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    const data = await response.json();
    console.log("Image upload result:", data);

    if (!data.success) {
      return res.status(500).json({ error: "Image upload failed", details: data });
    }

    res.json({ url: data.data.url });
  } catch (err) {
    res.status(500).json({ error: "Server error", details: err.message });
  }
});


// ==========================================
// VIDEO UPLOAD → StreamingVideoProvider
// ==========================================
app.post("/upload-video", upload.single("video"), async (req, res) => {
  const file = req.file;

  if (!file) return res.status(400).json({ error: "No video uploaded" });
  if (!file.mimetype.startsWith("video/")) {
    return res.status(400).json({ error: "Only video files allowed" });
  }

  const API_USER = "apc-zyKszquKnpuM";
  const API_PASS = "apc-GCEDq8FGuzEG";

  try {
    const apiUrl =
      `https://api.streamingvideoprovider.com/?username=${API_USER}&password=${API_PASS}&action=video.upload`;

    const form = new FormData();
    form.append("file", file.buffer, file.originalname);

    const response = await fetch(apiUrl, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    const data = await response.json();
    console.log("SVP upload:", data);

    if (!data.video_id) {
      return res.status(500).json({ error: "SVP upload failed", raw: data });
    }

    res.json({ url: `https://play.streamingvideoprovider.com/${data.video_id}` });
  } catch (err) {
    res.status(500).json({ error: "SVP error", details: err.message });
  }
});


// ==========================================
// Start Server
// ==========================================
app.listen(25588, () =>
  console.log("🔥 Server running at http://localhost:25588")
);
