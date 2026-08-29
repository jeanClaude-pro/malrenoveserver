const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parsePagination(query = {}) {
  const rawPage = Number.parseInt(query.page, 10);
  const rawLimit = Number.parseInt(query.limit, 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;
  return { page, limit, skip: (page - 1) * limit };
}

function paginationMeta(page, limit, totalRecords) {
  const totalPages = totalRecords === 0 ? 0 : Math.ceil(totalRecords / limit);
  return {
    page,
    limit,
    totalRecords,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && totalPages > 0,
  };
}

async function aggregatePage(Model, match, page, limit, extraFacets = {}) {
  const [result = {}] = await Model.aggregate([
    { $match: match },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $facet: {
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        metadata: [{ $count: "totalRecords" }],
        ...extraFacets,
      },
    },
  ]);
  const totalRecords = result.metadata?.[0]?.totalRecords || 0;
  return {
    data: result.data || [],
    pagination: paginationMeta(page, limit, totalRecords),
    facets: result,
  };
}

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, parsePagination, paginationMeta, aggregatePage };
