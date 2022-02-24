// Endpoint to some DNS Over HTTPS json API server
// Other considered: https://mozzila.cloudflare-dns.com/dns-query, https://dns.google/resolve
const dnsEndpointUrl = 'https://cloudflare-dns.com/dns-query'

// Default headers for addon response
const headers = {
	'Access-Control-Allow-Methods': 'GET',
	'Access-Control-Allow-Origin': '*',
	'Content-Type': 'application/json; charset=utf-8',
	'Transfer-Encoding': 'chunked',
}

const idPrefix = 'rbi:'
const manifest = {
	id: 'info.radio-browser.unofficial',
	version: '0.0.1',
	description:
		'Unofficial addon for streams from www.radio-browser.info.\nThis is a community driven effort (like wikipedia) with the aim of collecting as many internet radio and TV stations as possible.',
	name: 'radio-browser',
	logo: 'https://www.radio-browser.info/favicon.ico',
	background:
		'https://upload.wikimedia.org/wikipedia/commons/a/a1/Altered_AWX_antenna.jpg',
	resources: ['catalog', 'meta', 'stream'],
	types: ['radio'],
	idPrefixes: [idPrefix],
	catalogs: [
		{
			type: 'radio',
			id: 'top',
			name: 'RB: Top',
			extra: [
				{ name: 'skip' },
				// May cause huge amount of traffic
				// { name: 'search' },
				{
					name: 'genre',
					options: [],
					kind: 'tags',
				},
			],
		},
		{
			type: 'radio',
			id: 'byCountry',
			name: 'RB: Countries',
			extra: [
				{ name: 'skip' },
				{
					name: 'genre',
					isRequired: true,
					options: [],
					kind: 'countries',
				},
			],
		},
	], // catalogs
}

class Countries {
	// Souce https://github.com/hampusborgos/country-flags/
	static #ISO_3166_NAMES = {}
	static #NAMES_TO_ISO_3166 = {}
	async init() {
		if (Object.keys(Countries.#ISO_3166_NAMES).length > 0) return
		// In the repo the JSON is https://cdn.jsdelivr.net/gh/hampusborgos/country-flags@main/countries.json
		// but the country names are bad
		Countries.#ISO_3166_NAMES = await (
			await fetch('http://country.io/names.json')
		).json()
		for (const [code, name] of Object.entries(Countries.#ISO_3166_NAMES)) {
			Countries.#NAMES_TO_ISO_3166[name] = code
		}
	}
	findByCode(code) {
		const name = Countries.#ISO_3166_NAMES[code.toUpperCase()]
		if (!name) return null
		const flagUrl = `https://cdn.jsdelivr.net/gh/hampusborgos/country-flags@main/png1000px/${code.toLowerCase()}.png`
		return { code, name, flagUrl }
	}
	findByName(name) {
		return this.findByCode(Countries.#NAMES_TO_ISO_3166[name] || '')
	}
}

class Doh {
	#server = null
	#fetchSettings = {
		headers: {
			accept: 'application/dns-json',
		},
	}
	constructor(server) {
		this.#server = new URL(server)
	}
	async getAnswer(name, type) {
		this.#server.search = new URLSearchParams({ name, type })
		return await fetch(this.#server, this.#fetchSettings)
			.then((resp) => resp.json())
			.then((resp) => resp.Answer.map((ans) => ans.data))
	}
	async resolve(name) {
		const type = 'A'
		return await this.getAnswer(name, type)
	}
	async reverse(ip) {
		const name = ip.split('.').reverse().join('.') + '.in-addr.arpa'
		const type = 'PTR'
		return (await this.getAnswer(name, type)).shift().slice(0, -1)
	}
}

class RadioBrowserServer {
	static #ALL_APIS_DOMAIN = 'all.api.radio-browser.info'
	static #SERVER = null
	static #SERVER_LAST_UPDATED = 0

	static SERVER_UPDATE_INTERVAL = 7200

	#doh = null

	constructor(dohServer) {
		this.#doh = new Doh(dohServer)
	}

	async #getEndpoint(path, params, force = false) {
		if (
			force ||
			!RadioBrowserServer.#SERVER ||
			RadioBrowserServer.#SERVER_LAST_UPDATED +
				RadioBrowserServer.SERVER_UPDATE_INTERVAL <
				Date.now()
		) {
			RadioBrowserServer.#SERVER_LAST_UPDATED = Date.now()
			const controller = new AbortController()
			const signal = controller.signal
			const addrs = await this.#doh.resolve(RadioBrowserServer.#ALL_APIS_DOMAIN)
			const domains = await Promise.all(
				addrs.map((ip) => this.#doh.reverse(ip).catch(() => null)),
			)
			RadioBrowserServer.#SERVER = await Promise.any(
				domains
					.filter((domain) => domain !== null)
					.map(async (domain) => {
						const resp = await fetch('https://' + domain + '/json/config', {
							method: 'GET',
							signal,
						})
						const cfg = await resp.json()
						return 'https://' + cfg.server_name + '/json'
					}),
			)
			controller.abort()
		}
		const apiServer = new URL(RadioBrowserServer.#SERVER)
		apiServer.pathname += path || ''
		if (params) apiServer.search = new URLSearchParams(params)
		return apiServer
	}

	async request(path, params) {
		return fetch(await this.#getEndpoint(path, params))
			.catch(async () => fetch(await this.#getEndpoint(path, params, true)))
			.then((resp) => resp.json())
	}
}

function mapRadioMeta(station, params, countries) {
	const image = station.favicon || 'https://www.radio-browser.info/favicon.ico'
	const cdata = countries.findByCode(station.countrycode)
	const meta = {
		id: idPrefix + station.stationuuid,
		name: station.name,
		description: [station.name, station.country]
			.filter((name) => name)
			.join(', '),
		type: params.type,
		genres: station.tags.split(/,\s*/),
		released: station.lastchangetime_iso8601,
		poster: image,
		logo: image,
		background: cdata?.flagUrl,
		posterShape: 'landscape',
		behaviorHints: {
			defaultVideoId: idPrefix + station.stationuuid,
		},
	}
	const streams = mapRadioStreams(station)
	if (streams.length > 1) {
		delete meta.behaviorHints.defaultVideoId
		meta.videos = streams.map((s, i) => ({
			id: i + ':' + meta.id,
			title: s.name + ' - ' + (s.url || s.externalUrl),
			released: new Date(new Date(meta.released).getTime() - i),
			thumbnail:
				'data:image/svg+xml,' +
				encodeURIComponent(
					s.externalUrl
						? '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="#FFFFFF"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>'
						: '<svg xmlns="http://www.w3.org/2000/svg" enable-background="new 0 0 24 24" height="24px" viewBox="0 0 24 24" width="24px" fill="#FFFFFF"><g><rect fill="none" height="24" width="24"/></g><g><path d="M12,3c-4.97,0-9,4.03-9,9v7c0,1.1,0.9,2,2,2h4v-8H5v-1c0-3.87,3.13-7,7-7s7,3.13,7,7v1h-4v8h4c1.1,0,2-0.9,2-2v-7 C21,7.03,16.97,3,12,3z M7,15v4H5v-4H7z M19,19h-2v-4h2V19z"/></g></svg>',
				),
			streams: [s],
		}))
	}
	return meta
}
function mapRadioStreams(station) {
	const streams = [
		{
			url: station.url,
			name: 'Listen now',
			title: station.url + '\n' + station.codec,
		},
	]
	if (station.homepage)
		streams.push({
			externalUrl: station.homepage,
			name: 'Home page',
			title: 'Visit website\n' + station.homepage,
		})
	return streams
}

const addon = {
	manifest: async () => {
		const now = new Date()
		manifest.version =
			now.getYear() + '.' + now.getMonth() + '.' + now.getDate()
		const genreCats = manifest.catalogs.filter((catalog) =>
			catalog.extra.find((extra) => extra.name === 'genre'),
		)

		const countries = new Countries()
		const server = new RadioBrowserServer(dnsEndpointUrl)
		const [countryList, tags] = await Promise.all([
			server.request('/countrycodes/', { hidebroken: 'true' }),
			server.request('/tags/', {
				hidebroken: 'true',
				limit: 100,
				reverse: 'true',
				order: 'stationcount',
			}),
			countries.init(),
		])
		for (const genreCat of genreCats) {
			const genres = genreCat.extra.find((extra) => extra.name === 'genre')
			switch (genres.kind) {
				case 'countries':
					genres.options = countryList.map(
						(country) => countries.findByCode(country.name).name,
					)
					genres.options.sort()
					break
				case 'tags':
					genres.options = tags.map((tag) => tag.name)
					break
			}
			delete genres.kind
		}
		return manifest
	},

	catalog: async (params) => {
		const skip = parseInt(params.extra?.skip, 10) || 0
		const countries = new Countries()
		await countries.init()
		const server = new RadioBrowserServer(dnsEndpointUrl)
		const filter = {
			hidebroken: 'true',
			limit: 101,
			offset: skip,
			order: 'votes',
			reverse: 'true',
		}
		switch (params.id) {
			case 'top':
				if (params.extra.genre) filter.tagList = params.extra.genre
				if (params.extra.search) filter.name = params.extra.search
				break
			case 'byCountry':
				filter.countrycode = countries.findByName(params.extra.genre)?.code
				break
		}

		const stations = await server.request('/stations/search', filter)

		const hasMore = stations.length > 100
		const metas = stations
			.slice(0, 100)
			.map((station) => mapRadioMeta(station, params, countries))

		return {
			metas,
			skip,
			hasMore,
		}
	},

	meta: async (params) => {
		const stationId = params.id.slice(idPrefix.length)
		const countries = new Countries()
		const server = new RadioBrowserServer(dnsEndpointUrl)
		const [[station]] = await Promise.all([
			server.request('/stations/byuuid/' + stationId),
			countries.init(),
		]).catch(() => [[null]])
		const meta = station ? mapRadioMeta(station, params, countries) : null
		return { meta }
	},

	stream: async (params) => {
		const stationId = params.id.slice(idPrefix.length)
		const countries = new Countries()
		const server = new RadioBrowserServer(dnsEndpointUrl)
		const [[station]] = await Promise.all([
			server.request('/stations/byuuid/' + stationId),
			countries.init(),
		]).catch(() => [[null]])
		const streams = station ? mapRadioStreams(station) : []
		return { streams }
	},
}

function parseSearch(search) {
	const args = {}
	for (const [key, val] of [...new URLSearchParams(search)]) {
		args[key] = args[key]
			? Array.isArray(args[key])
				? args[key].concat(val)
				: [args[key], val]
			: val
	}
	return args
}
function parseUrl(url) {
	const reqUrl = new URL(url)
	if (!reqUrl.pathname.endsWith('.json')) return null
	const allowedResources = manifest.resources.concat('manifest')
	const [resource, type, id, extra] = reqUrl.pathname
		// Remove the leading / and the .json extension
		.slice(1, -5)
		.split('/')
	if (!allowedResources.includes(resource)) return null
	const res = {
		resource,
		params: {
			type,
			id,
			extra: parseSearch(extra),
		},
	}
	return res
}

export default {
	async fetch(request, env, ctx) {
		if (request.method !== 'GET')
			return new Response('Method Not Allowed', {
				status: 405,
				statusText: 'Method Not Allowed',
				headers: { 'content-type': 'text/plain' },
			})
		const res = parseUrl(request.url)
		if (!res)
			return new Response('404 Not Found', {
				status: 404,
				statusText: 'Not Found',
				headers: { 'content-type': 'text/plain' },
			})
		if (typeof addon[res.resource] === 'function')
			return new Response(
				JSON.stringify(await addon[res.resource](res.params)),
				{ headers },
			)

		return new Response(JSON.stringify(res), { headers })
	},
	async scheduled(event, env, ctx) {
		await fetch('https://api.strem.io/api/addonPublish', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				transportUrl: 'https://radiobrowser.core1024.workers.dev/manifest.json',
			}),
		})
	},
}
