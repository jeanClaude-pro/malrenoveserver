function toTotalPieces(cartons, loosePieces, piecesPerCarton) {
  return cartons * piecesPerCarton + loosePieces;
}

function fromTotalPieces(totalPieces, piecesPerCarton) {
  return {
    cartons: Math.floor(totalPieces / piecesPerCarton),
    loosePieces: totalPieces % piecesPerCarton,
  };
}

module.exports = { toTotalPieces, fromTotalPieces };
