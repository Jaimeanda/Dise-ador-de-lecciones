const mammoth = require('mammoth');
const fs = require('fs');

async function extract() {
    try {
        const text1 = await mammoth.extractRawText({ path: './Ejemplos/Guía #1 Simple past.docx' });
        fs.writeFileSync('ejemplo1.txt', text1.value);

        const text2 = await mammoth.extractRawText({ path: './Ejemplos/Guía de estudio #3 Simple Present.docx' });
        fs.writeFileSync('ejemplo2.txt', text2.value);
        console.log("Extracted successfully");
    } catch (e) {
        console.error(e);
    }
}
extract();
