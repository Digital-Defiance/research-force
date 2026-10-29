// Replaces "accessed [date of access]" in the Citation_Line with the Visitor's local date (R29.9); kept to about 1 KB, so it imports nothing.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const today = new Date();
const accessed = `accessed ${today.getDate()} ${MONTHS[today.getMonth()]} ${today.getFullYear()}`;
for (const node of document.querySelectorAll('[data-citation-access]')) node.textContent = accessed;
