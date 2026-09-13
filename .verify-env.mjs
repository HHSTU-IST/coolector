const env = ""
console.log("nullish:", JSON.stringify(env ?? "*"))
const A = (env ?? "*").split(",").map(v => v.trim()).filter(Boolean)
console.log("allowed:", JSON.stringify(A))
console.log("allowAll:", A.includes("*"))
console.log("tokenOff-when-empty:", !(""))
