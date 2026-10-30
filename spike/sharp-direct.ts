import sharp from "sharp";
const b = await sharp(process.argv[2]).webp().toBuffer();
console.log("sharp ok", b.length);
